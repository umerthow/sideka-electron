import {registerFormula} from './../formulaRegisterer';
import {createArrayAssertion} from './../utils';

export const FORMULA_NAME = 'by_value';

function formula(dataRow, [value] = inputValues) {
  return value(dataRow.value);
}

registerFormula(FORMULA_NAME, formula, {
  name: 'Bernilai',
  inputsCount: 0,
  inputValuesDecorator: function([data] = inputValues) {
    return [createArrayAssertion(data)];
  }
});
