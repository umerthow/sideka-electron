import {arrayEach, arrayMap} from 'handsontable/helpers/array';
import {rangeEach} from 'handsontable/helpers/number';
import {CellValue} from './cell/value';
import {CellReference} from './cell/reference';
import {isFormulaExpression, toUpperCaseFormula} from './utils';
import {Matrix} from './matrix';
import {AlterManager} from './alterManager';
import {localHooks} from 'handsontable/mixins/localHooks';
import {getTranslator} from 'handsontable/utils/recordTranslator';
import {objectEach, mixin} from 'handsontable/helpers/object';
import {Parser, ERROR_REF} from 'hot-formula-parser';

const STATE_UP_TO_DATE = 1;
const STATE_NEED_REBUILD = 2;
const STATE_NEED_FULL_REBUILD = 3;

/**
 * @class Sheet
 * @util
 */
class Sheet {
  constructor(hot, dataProvider) {
    /**
     * Handsontable instance.
     *
     * @type {Core}
     */
    this.hot = hot;
    /**
     * Record translator for translating visual records into psychical and vice versa.
     *
     * @type {RecordTranslator}
     */
    this.t = getTranslator(this.hot);
    /**
     * Data provider for sheet calculations.
     *
     * @type {DataProvider}
     */
    this.dataProvider = dataProvider;
    /**
     * Instance of {@link https://github.com/handsontable/formula-parser}.
     *
     * @type {Parser}
     */
    this.parser = new Parser();
    /**
     * Instance of {@link Matrix}.
     *
     * @type {Matrix}
     */
    this.matrix = new Matrix(this.t);
    /**
     * Instance of {@link AlterManager}.
     *
     * @type {AlterManager}
     */
    this.alterManager = new AlterManager(this);
    /**
     * Cell object which indicates which cell is currently processing.
     *
     * @private
     * @type {null}
     */
    this._processingCell = null;
    /**
     * State of the sheet.
     *
     * @type {Number}
     * @private
     */
    this._state = STATE_NEED_FULL_REBUILD;

    this.parser.on('callCellValue', (...args) => this._onCallCellValue(...args));
    this.parser.on('callRangeValue', (...args) => this._onCallRangeValue(...args));
    this.alterManager.addLocalHook('afterAlter', (...args) => this._onAfterAlter(...args));
  }

  /**
   * Recalculate sheet.
   */
  recalculate() {
    switch (this._state) {
      case STATE_NEED_FULL_REBUILD:
        this.recalculateFull();
        break;
      case STATE_NEED_REBUILD:
        this.recalculateOptimized();
        break;
    }
  }

  /**
   * Recalculate sheet using optimized methods (fast recalculation).
   */
  recalculateOptimized() {
    const cells = this.matrix.getOutOfDateCells();

    arrayEach(cells, (cellValue) => {
      const value = this.dataProvider.getSourceDataAtCell(cellValue.row, cellValue.column);

      if (isFormulaExpression(value)) {
        this.parseExpression(cellValue, value.substr(1));
      }
    });

    this._state = STATE_UP_TO_DATE;
    this.runLocalHooks('afterRecalculate', cells, 'optimized');
  }

  /**
   * Recalculate whole table by building dependencies from scratch (slow recalculation).
   */
  recalculateFull() {
    const cells = this.dataProvider.getSourceDataByRange();

    this.matrix.reset();

    arrayEach(cells, (rowData, row) => {
      arrayEach(rowData, (value, column) => {
        if (isFormulaExpression(value)) {
          this.parseExpression(new CellValue(row, column), value.substr(1));
        }
      });
    });

    this._state = STATE_UP_TO_DATE;
    this.runLocalHooks('afterRecalculate', cells, 'full');
  }

  /**
   * Set predefined variable name which can be visible while parsing formula expression.
   *
   * @param {String} name Variable name.
   * @param {*} value Variable value.
   */
  setVariable(name, value) {
    this.parser.setVariable(name, value);
  }

  /**
   * Get variable name.
   *
   * @param {String} name Variable name.
   * @returns {*}
   */
  getVariable(name) {
    return this.parser.getVariable(name);
  }

  /**
   * Apply changes to the sheet.
   *
   * @param {Number} row Physical row index.
   * @param {Number} column Physical column index.
   * @param {*} newValue Current cell value.
   */
  applyChanges(row, column, newValue) {
    // Remove formula description for old expression
    // TODO: Move this to recalculate()
    this.matrix.remove({row, column});

    // TODO: Move this to recalculate()
    if (isFormulaExpression(newValue)) {
      // ...and create new for new changed formula expression
      this.parseExpression(new CellValue(row, column), newValue.substr(1));
    }

    const deps = this.getCellDependencies(...this.t.toVisual(row, column));

    arrayEach(deps, (cellValue) => {
      cellValue.setState(CellValue.STATE_OUT_OFF_DATE);
    });

    this._state = STATE_NEED_REBUILD;
  }

  /**
   * Parse and evaluate formula for provided cell.
   *
   * @param {CellValue|Object} cellValue Cell value object.
   * @param {String} formula Value to evaluate.
   */
  parseExpression(cellValue, formula) {
    cellValue.setState(CellValue.STATE_COMPUTING);
    this._processingCell = cellValue;

    const {error, result} = this.parser.parse(toUpperCaseFormula(formula));

    cellValue.setValue(result);
    cellValue.setError(error);
    cellValue.setState(CellValue.STATE_UP_TO_DATE);

    this.matrix.add(cellValue);
    this._processingCell = null;
  }

  /**
   * Get cell value object at specified physical coordinates.
   *
   * @param {Number} row Physical row index.
   * @param {Number} column Physical column index.
   * @returns {CellValue|undefined}
   */
  getCellAt(row, column) {
    return this.matrix.getCellAt(row, column);
  }

  /**
   * Get cell dependencies at specified physical coordinates.
   *
   * @param {Number} row Physical row index.
   * @param {Number} column Physical column index.
   * @returns {Array}
   */
  getCellDependencies(row, column) {
    return this.matrix.getDependencies({row, column});
  }

  /**
   * Listener for parser cell value.
   *
   * @private
   * @param {Object} cellCoords Cell coordinates.
   * @param {Function} done Function to call with valid cell value.
   */
  _onCallCellValue({row, column}, done) {
    const cell = new CellReference(row, column);

    if (!this.dataProvider.isInDataRange(cell.row, cell.column)) {
      throw Error(ERROR_REF);
    }

    this.matrix.registerCellRef(cell);
    this._processingCell.addPrecedent(cell);

    done(this.dataProvider.getDataAtCell(row.index, column.index));
  }

  /**
   * Listener for parser cells (range) value.
   *
   * @private
   * @param {Object} startCell Cell coordinates (top-left corner coordinate).
   * @param {Object} endCell Cell coordinates (bottom-right corner coordinate).
   * @param {Function} done Function to call with valid cells values.
   */
  _onCallRangeValue({row: startRow, column: startColumn}, {row: endRow, column: endColumn}, done) {
    rangeEach(startRow.index, endRow.index, (row) => {
      rangeEach(startColumn.index, endColumn.index, (column) => {
        let cell = new CellReference(row, column);

        this.matrix.registerCellRef(cell);
        this._processingCell.addPrecedent(cell);
      });
    });

    done(this.dataProvider.getDataByRange(startRow.index, startColumn.index, endRow.index, endColumn.index));
  }

  /**
   * On after alter sheet listener.
   *
   * @private
   */
  _onAfterAlter() {
    this.recalculateOptimized();
  }

  /**
   * Destroy class.
   */
  destroy() {
    this.hot = null;
    this.t = null;
    this.dataProvider.destroy();
    this.dataProvider = null;
    this.alterManager.destroy();
    this.alterManager = null;
    this.parser = null;
    this.matrix.reset();
    this.matrix = null;
  }
}

mixin(Sheet, localHooks);

export {Sheet};
