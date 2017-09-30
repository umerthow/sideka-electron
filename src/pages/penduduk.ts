import { remote, shell } from 'electron';
import { Component, ApplicationRef, ViewChild, ViewContainerRef, NgZone, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { Progress } from 'angular-progress-http';
import { ToastsManager } from 'ng2-toastr';

import { pendudukImporterConfig, Importer } from '../helpers/importer';
import { exportPenduduk } from '../helpers/exporter';
import { Diff, DiffTracker } from "../helpers/diffTracker";
import { PersistablePage } from '../pages/persistablePage';

import * as path from 'path';
import * as uuid from 'uuid';
import * as jetpack from 'fs-jetpack';

import 'rxjs/add/operator/finally';

import DataApiService from '../stores/dataApiService';
import SettingsService from '../stores/settingsService';
import SharedService from '../stores/sharedService';
import TableHelper from '../helpers/table';
import schemas from '../schemas';
import titleBar from '../helpers/titleBar';
import ProdeskelWebDriver from '../helpers/prodeskelWebDriver';
import PendudukStatisticComponent from '../components/pendudukStatistic';
import PaginationComponent from '../components/pagination';
import ProgressBarComponent from '../components/progressBar';
import PageSaver from '../helpers/pageSaver';

var base64 = require("uuid-base64");
var $ = require('jquery');
var Handsontable = require('./lib/handsontablep/dist/handsontable.full.js');

const SHOW_COLUMNS = [
    schemas.penduduk.filter(e => e.field !== 'id').map(e => e.field),
    ["nik", "nama_penduduk", "tempat_lahir", "tanggal_lahir", "jenis_kelamin", "pekerjaan", "kewarganegaraan", "rt", "rw", "nama_dusun", "agama", "alamat_jalan"],
    ["nik", "nama_penduduk", "no_telepon", "email", "rt", "rw", "nama_dusun", "alamat_jalan"],
    ["nik", "nama_penduduk", "tempat_lahir", "tanggal_lahir", "jenis_kelamin", "nama_ayah", "nama_ibu", "hubungan_keluarga", "no_kk"]
];

enum Mutasi { pindahPergi = 1, pindahDatang = 2, kelahiran = 3, kematian = 4 };

@Component({
    selector: 'penduduk',
    templateUrl: 'templates/penduduk.html'
})
export default class PendudukComponent implements OnDestroy, OnInit, PersistablePage {
    sheets: any[];
    trimmedRows: any[];
    keluargaCollection: any[];
    details: any[];
    resultBefore: any[];
    activeSheet: any;
    hots: any;
    importer: any;
    tableHelper: any;
    isFiltered: boolean;
    isPendudukEmpty: boolean;
    selectedPenduduk: any;
    selectedDetail: any;
    selectedKeluarga: any;
    selectedDiff: string;
    diffTracker: DiffTracker;
    selectedMutasi: Mutasi;
    afterSaveAction: string;
    progress: Progress;
    progressMessage: string;
    inputSearch: any;
    pageSaver: PageSaver;
    pendudukAfterRemoveRowHook: any;
    pendudukAfterFilterHook: any;
    pendudukSubscription: Subscription;
    modalSaveId: string;

    activePageMenu: string;
    
    @ViewChild(PaginationComponent)
    paginationComponent: PaginationComponent;

    constructor(
        private toastr: ToastsManager,
        private vcr: ViewContainerRef,
        private appRef: ApplicationRef,
        private ngZone: NgZone,
        private router: Router,
        public dataApiService: DataApiService,
        private settingsService: SettingsService,
        private sharedService: SharedService
    ) {
        this.toastr.setRootViewContainerRef(vcr);
        this.pageSaver = new PageSaver(this, sharedService, settingsService, router, toastr);
    }

    ngOnInit(): void {
        titleBar.title("Data Penduduk - " + this.dataApiService.getActiveAuth()['desa_name']);
        titleBar.blue();

        this.progressMessage = '';
        this.progress = {
            percentage: 0,
            total: 0,
            event: null,
            lengthComputable: true,
            loaded: 0
        };

        this.modalSaveId = 'modal-save-diff';
        this.trimmedRows = [];
        this.keluargaCollection = [];
        this.details = [];
        this.resultBefore = [];
        this.pageSaver.bundleData = { "penduduk": [], "mutasi": [], "log_surat": [] };
        this.pageSaver.bundleSchemas = { "penduduk": schemas.penduduk, "mutasi": schemas.mutasi, "log_surat": schemas.logSurat };
        this.sheets = ['penduduk', 'mutasi', 'logSurat'];
        this.hots = { "penduduk": null, "mutasi": null, "logSurat": null };
        this.paginationComponent.itemPerPage = parseInt(this.settingsService.get('maxPaging'));
        this.selectedPenduduk = schemas.arrayToObj([], schemas.penduduk);
        this.selectedDetail = schemas.arrayToObj([], schemas.penduduk);
        this.diffTracker = new DiffTracker();

        this.importer = new Importer(pendudukImporterConfig);
        this.pageSaver.subscription = this.pendudukSubscription;

        this.sheets.forEach(sheet => {
            let element = $('.' + sheet + '-sheet')[0];
            let schema = schemas[sheet];

            if (!element || !schema)
                return;

            this.hots[sheet] = new Handsontable(element, {
                data: [],
                topOverlay: 34,
                rowHeaders: true,
                colHeaders: schemas.getHeader(schema),
                columns: schemas.getColumns(schema),
                colWidths: schemas.getColWidths(schema),
                rowHeights: 23,
                columnSorting: true,
                sortIndicator: true,
                hiddenColumns: { columns: [0], indicators: true },
                renderAllRows: false,
                outsideClickDeselects: false,
                autoColumnSize: false,
                search: true,
                schemaFilters: true,
                contextMenu: ['undo', 'redo', 'row_above', 'remove_row'],
                dropdownMenu: ['filter_by_condition', 'filter_action_bar']
            });
        });

        this.hots['keluarga'] = new Handsontable($('.keluarga-sheet')[0], {
            data: [],
            topOverlay: 34,
            rowHeaders: true,
            colHeaders: schemas.getHeader(schemas.penduduk),
            columns: schemas.getColumns(schemas.penduduk),
            colWidths: schemas.getColWidths(schemas.penduduk),
            rowHeights: 23,
            columnSorting: true,
            sortIndicator: true,
            hiddenColumns: { columns: [0], indicators: true },
            renderAllRows: false,
            outsideClickDeselects: false,
            autoColumnSize: false,
            search: true,
            schemaFilters: true,
            contextMenu: ['undo', 'redo', 'row_above', 'remove_row'],
            dropdownMenu: ['filter_by_condition', 'filter_action_bar']
        });

        this.pendudukAfterFilterHook = (formulas) => {
            let plugin = this.hots['penduduk'].getPlugin('trimRows');

            if (this.paginationComponent.itemPerPage) {
                if (plugin.trimmedRows.length === 0) {
                    this.trimmedRows = [];
                    this.isFiltered = false;
                }

                else {
                    this.trimmedRows = plugin.trimmedRows.slice();
                    this.isFiltered = true;
                }

                if (formulas.length === 0)
                    this.paginationComponent.totalItems = this.hots['penduduk'].getSourceData().length;
                else
                    this.paginationComponent.totalItems = this.trimmedRows.length;

                this.paginationComponent.setCurrentPage(1);
                this.paginationComponent.calculatePages();

                this.pagingData();
            }
            else {
                if (plugin.trimmedRows.length === 0) {
                    this.trimmedRows = [];
                    this.isFiltered = false;
                }
                else {
                    this.trimmedRows = plugin.trimmedRows.slice();
                    this.isFiltered = true;
                }
            }
        }
        
        this.pendudukAfterRemoveRowHook = (index, amount) => {
            this.checkPendudukHot();
        }
        
        this.hots['penduduk'].addHook('afterFilter', this.pendudukAfterFilterHook);    
        this.hots['penduduk'].addHook('afterRemoveRow', this.pendudukAfterRemoveRowHook);

        let spanSelected = $("#span-selected")[0];
        let spanCount = $("#span-count")[0];
        let inputSearch = document.getElementById("input-search");

        this.tableHelper = new TableHelper(this.hots['penduduk'], inputSearch);
        this.tableHelper.initializeTableSelected(this.hots['penduduk'], 2, spanSelected);
        this.tableHelper.initializeTableCount(this.hots['penduduk'], spanCount);
        this.tableHelper.initializeTableSearch(document, null);

        document.addEventListener('keyup', this.keyupListener, false);

        this.progressMessage = 'Memuat data';
        this.setActiveSheet('penduduk');

        this.pageSaver.getContent('penduduk', null, this.progressListener.bind(this),
            (err, notifications, isSyncDiffs, data) => {
                if(err){
                    this.toastr.error(err);
                    this.loadAllData(data);
                    this.checkPendudukHot();
                    return;
                }

                notifications.forEach(notification => {
                    this.toastr.info(notification);
                });

                this.loadAllData(data);
                this.checkPendudukHot();
                this.dataApiService.writeFile(data, this.sharedService.getPendudukFile(), null);

                if(isSyncDiffs)
                    this.saveContent(false);
                else
                    this.transformBundle(data);
            });
    }

    ngOnDestroy(): void {    
        if (this.pendudukSubscription)
            this.pendudukSubscription.unsubscribe();

        document.removeEventListener('keyup', this.keyupListener, false); 

        if (this.pendudukAfterFilterHook)
            this.hots['penduduk'].removeHook('afterFilter', this.pendudukAfterFilterHook);
        if (this.pendudukAfterRemoveRowHook)
            this.hots['penduduk'].removeHook('afterRemoveRow', this.pendudukAfterRemoveRowHook); 
        
        this.progress.percentage = 100;

        this.tableHelper.removeListenerAndHooks();
        this.hots['penduduk'].destroy();
        this.hots['mutasi'].destroy();
        this.hots['logSurat'].destroy();
        this.hots['keluarga'].destroy();
        this.hots = null;
        
        titleBar.removeTitle();
    }

    saveContent(isTrackingDiff: boolean): void {
        $('#modal-save-diff').modal('hide');

        this.pageSaver.bundleData['penduduk'] = this.hots['penduduk'].getSourceData();
        this.pageSaver.bundleData['mutasi'] = this.hots['mutasi'].getSourceData();
        this.pageSaver.bundleData['log_surat'] = this.hots['logSurat'].getSourceData();

        this.progressMessage = 'Menyimpan Data';

        this.pageSaver.saveContent('penduduk', null, isTrackingDiff, 
            this.progressListener.bind(this), (err, data) => {
    
            this.transformBundle(data);
            this.dataApiService.writeFile(data, this.sharedService.getPendudukFile(), null);
            this.pageSaver.onAfterSave();

            if(this.pageSaver.afterSaveAction === 'home')
                return

            if(err){
                this.toastr.error(err);
            }
            else{
                this.loadAllData(data);
                this.toastr.success('Data berhasil disimpan ke server');
            }
        });
    }

    loadAllData(bundle) {
        let me = this;
        
        me.hots['penduduk'].loadData(bundle['data']['penduduk']);
        me.hots['mutasi'].loadData(bundle['data']['mutasi']);
        me.hots['logSurat'].loadData(bundle['data']['log_surat']);

        this.pageSaver.bundleData['penduduk'] = bundle['data']['penduduk'];
        this.pageSaver.bundleData['mutasi'] = bundle['data']['mutasi'];
        this.pageSaver.bundleData['log_surat'] = bundle['data']['log_surat'];

        let pendudukData = bundle['data']['penduduk'];

        setTimeout(() => {
            me.setPaging(bundle['data']['penduduk']);
            me.hots['penduduk'].render();
            me.hots['mutasi'].render();
            me.hots['logSurat'].render();
        }, 200);
    }

    mergeContent(newBundle, oldBundle): any {
        let condition = newBundle['diffs'] ? 'has_diffs' : newBundle['data'] instanceof Array ? 'v1_version' : 'new_setup';
        let keys = Object.keys(this.pageSaver.bundleData);

        switch(condition){
            case 'has_diffs':
                keys.forEach(key => {
                    let newDiffs = newBundle['diffs'][key] ? newBundle['diffs'][key] : [];
                    oldBundle['data'][key] = this.dataApiService.mergeDiffs(newDiffs, oldBundle['data'][key]);
                });
                break;
            case 'v1_version':
                oldBundle["data"]["penduduk"] = newBundle["data"];
                break;
            case 'new_setup':
                keys.forEach(key => {
                    oldBundle['data'][key] = newBundle['data'][key] ? newBundle['data'][key] : [];
                });
                break;
        }
        
        oldBundle.changeId = newBundle.change_id ? newBundle.change_id : newBundle.changeId;
        return oldBundle;
    }

    trackDiffs(localData, realTimeData): any {
        return {
            "penduduk": this.diffTracker.trackDiff(localData['penduduk'], realTimeData['penduduk']),
            "mutasi": this.diffTracker.trackDiff(localData['mutasi'], realTimeData['mutasi']),
            "log_surat": this.diffTracker.trackDiff(localData['log_surat'], realTimeData['log_surat'])
        };
    }

    progressListener(progress: Progress) {
        this.progress = progress;
    }

    setPaging(data): void {
        if (this.paginationComponent.itemPerPage && data.length > this.paginationComponent.itemPerPage) {
            this.paginationComponent.setCurrentPage(1);
            this.paginationComponent.totalItems = data.length;
            this.paginationComponent.calculatePages();
            this.pagingData();
        }
    }

    pagingData(): void {
        let hot = this.hots['penduduk'];

        hot.scrollViewportTo(0);

        let plugin = hot.getPlugin('trimRows');
        let dataLength = hot.getSourceData().length;
        let currentPage = this.paginationComponent.getCurrentPage();

        let pageBegin = (currentPage - 1) * this.paginationComponent.itemPerPage;
        let offset = currentPage * this.paginationComponent.itemPerPage;

        let sourceRows = [];
        let rows = [];

        plugin.untrimAll();

        if (this.trimmedRows.length > 0)
            plugin.trimRows(this.trimmedRows);

        for (let i = 0; i < dataLength; i++)
            sourceRows.push(i);

        if (this.trimmedRows.length > 0)
            rows = sourceRows.filter(e => plugin.trimmedRows.indexOf(e) < 0);
        else
            rows = sourceRows;

        let displayedRows = rows.slice(pageBegin, offset);

        plugin.trimRows(sourceRows);
        plugin.untrimRows(displayedRows);
    }

    setActiveSheet(sheet): boolean {
        if (this.activeSheet) 
            this.hots[this.activeSheet].unlisten();
        
        this.activeSheet = sheet;

        if (this.activeSheet) 
            this.hots[this.activeSheet].listen();

        this.selectedDetail = null;
        this.selectedKeluarga = null;
        return false;
    }

    checkPendudukHot(): void {
        this.isPendudukEmpty = this.hots['penduduk'].getSourceData().length > 0 ? false : true;
    }

    getCurrentDiffs(): any {
        let pendudukData = this.hots['penduduk'].getSourceData();
        let mutasiData = this.hots['mutasi'].getSourceData();
        let logSuratData = this.hots['logSurat'].getSourceData();
        let localBundle = this.dataApiService.getLocalContent('penduduk', this.pageSaver.bundleSchemas);

        return this.trackDiffs(localBundle["data"],
            { "penduduk": pendudukData, "mutasi": mutasiData, "log_surat": logSuratData });
    }

    showSurat(show): void {
        let hot = this.hots['penduduk'];

        if (!hot.getSelected()) {
            this.toastr.warning('Tidak ada penduduk yang dipilih');
            return
        }
        let penduduk = hot.getDataAtRow(hot.getSelected()[0]);
        this.selectedPenduduk = schemas.arrayToObj(penduduk, schemas.penduduk);

        this.setActivePageMenu(show ? 'surat' : null);
    }

    setActivePageMenu(activePageMenu){
        this.activePageMenu = activePageMenu;

        if (activePageMenu) {
            titleBar.normal();
            this.hots[this.activeSheet].unlisten();
        } else {
            titleBar.blue();
            this.hots[this.activeSheet].listen();
        }
    }

    addDetail(): void {
        let hot = this.hots['penduduk'];

        if (!hot.getSelected()) {
            this.toastr.warning('Tidak ada penduduk yang dipilih');
            return
        }

        let data = schemas.arrayToObj(hot.getDataAtRow(hot.getSelected()[0]), schemas.penduduk);

        let detail = {
            "headers": schemas.penduduk.map(c => c.header),
            "fields": schemas.penduduk.map(c => c.field),
            "data": data
        };

        let existingDetail = this.details.filter(e => e[0] === detail.data.id)[0];

        if (!existingDetail)
            this.details.push(detail);

        this.selectedDetail = this.details[this.details.length - 1];
        this.activeSheet = null;
        this.selectedKeluarga = null;
    }

    setDetail(detail): boolean {
        this.selectedDetail = detail;
        this.selectedKeluarga = null;
        this.activeSheet = null;
        return false;
    }

    removeDetail(detail): boolean {
        let index = this.details.indexOf(detail);

        if (index > -1)
            this.details.splice(index, 1);

        if (this.details.length === 0)
            this.setActiveSheet('penduduk');
        else
            this.setDetail(this.details[this.details.length - 1]);

        return false;
    }

    addKeluarga(): void {
        let hot = this.hots['penduduk'];

        if (!hot.getSelected()) {
            this.toastr.warning('Tidak ada penduduk yang dipilih');
            return
        }

        let penduduk = schemas.arrayToObj(hot.getDataAtRow(hot.getSelected()[0]), schemas.penduduk);

        if (!penduduk.no_kk) {
            this.toastr.error('No KK tidak ditemukan');
            return;
        }

        let keluarga: any[] = hot.getSourceData().filter(e => e['22'] === penduduk.no_kk);

        if (keluarga.length > 0) {
            this.keluargaCollection.push({
                "kk": penduduk.no_kk,
                "data": keluarga
            });
        }

        this.selectedKeluarga = this.keluargaCollection[this.keluargaCollection.length - 1];
        this.hots['keluarga'].loadData(this.selectedKeluarga.data);

        var plugin = this.hots['keluarga'].getPlugin('hiddenColumns');
        var fields = schemas.penduduk.map(c => c.field);
        var result = PageSaver.spliceArray(fields, SHOW_COLUMNS[0]);

        plugin.showColumns(this.resultBefore);
        plugin.hideColumns(result);

        this.selectedDetail = null;
        this.activeSheet = null;
        this.appRef.tick();

        this.hots['keluarga'].render();
    }

    setKeluarga(kk): boolean {
        if (!kk) {
            this.toastr.error('KK tidak ditemukan');
            return;
        }

        let hot = this.hots['penduduk']
        let keluarga: any = this.keluargaCollection.filter(e => e['kk'] === kk)[0];

        if (!keluarga)
            return false;

        this.selectedKeluarga = keluarga;
        this.hots['keluarga'].loadData(this.selectedKeluarga.data);
        this.hots['keluarga'].loadData(this.selectedKeluarga.data);

        var plugin = this.hots['keluarga'].getPlugin('hiddenColumns');
        var fields = schemas.penduduk.map(c => c.field);
        var result = PageSaver.spliceArray(fields, SHOW_COLUMNS[0]);

        plugin.showColumns(this.resultBefore);
        plugin.hideColumns(result);

        this.selectedDetail = null;
        this.activeSheet = null;
        this.appRef.tick();

        this.hots['keluarga'].render();
        this.hots['keluarga'].listen();

        return false;
    }

    removeKeluarga(keluarga): boolean {
        let index = this.keluargaCollection.indexOf(keluarga);

        if (index > -1)
            this.keluargaCollection.splice(index, 1);

        if (this.keluargaCollection.length === 0)
            this.setActiveSheet('penduduk');
        else
            this.setKeluarga(keluarga);

        return false;
    }

    insertRow(): void {
        let hot = this.hots['penduduk'];
        hot.alter('insert_row', 0);
        hot.setDataAtCell(0, 0, base64.encode(uuid.v4()));

        this.checkPendudukHot();
    }

    reloadSurat(data): void {
        let localBundle = this.dataApiService.getLocalContent('penduduk', this.pageSaver.bundleSchemas);
        let diffs = this.diffTracker.trackDiff(localBundle['data']['log_surat'], data);
        localBundle['diffs']['log_surat'] = localBundle['diffs']['log_surat'].concat(diffs);

        this.dataApiService.saveContent('penduduk', null, localBundle, this.pageSaver.bundleSchemas, this.progressListener.bind(this)).subscribe(
            result => {
                this.toastr.success('Log surat berhasil disimpan');

                let mergedResult = this.mergeContent(result, localBundle);
                mergedResult = this.mergeContent(localBundle, mergedResult);

                localBundle['diffs']['log_surat'] = [];
                localBundle['data']['log_surat'] = mergedResult['data']['log_surat'];
                
                this.dataApiService.writeFile(localBundle, this.sharedService.getPendudukFile(), null);
                this.hots['logSurat'].loadData(data);
                this.hots['logSurat'].render();
            },
            error => {
                this.toastr.error('Log surat gagal disimpan');
            }
        );
    }

    importExcel(): void {
        let files = remote.dialog.showOpenDialog(null);
        if (files && files.length) {
            this.importer.init(files[0]);
            $("#modal-import-columns").modal("show");
        }
    }

    doImport(overwrite): void {
        $("#modal-import-columns").modal("hide");
        let objData = this.importer.getResults();

        let undefinedIdData = objData.filter(e => !e['id']);
        for (let i = 0; i < objData.length; i++) {
            let item = objData[i];
            item['id'] = base64.encode(uuid.v4());
        }
        let existing = overwrite ? [] : this.hots['penduduk'].getSourceData();
        let imported = objData.map(o => schemas.objToArray(o, schemas.penduduk));
        let data = existing.concat(imported);

        this.hots['penduduk'].loadData(data);
        this.setPaging(data);
        this.checkPendudukHot();
        this.hots['penduduk'].render();
    }

    exportExcel(): void {
        let hot = this.hots['penduduk'];
        let data = [];
        if (this.isFiltered)
            data = hot.getData();
        else
            data = hot.getSourceData();

        exportPenduduk(data, "Data Penduduk");
    }

    openMutasiDialog(): void {
        this.changeMutasi(Mutasi.kelahiran);

        if (this.hots['penduduk'].getSelected())
            this.changeMutasi(Mutasi.pindahPergi);

        $('#mutasi-modal').modal('show');
    }

    changeMutasi(mutasi): void {
        let hot = this.hots['penduduk'];

        this.selectedMutasi = mutasi;
        this.selectedPenduduk = [];

        if (this.selectedMutasi === Mutasi.pindahPergi || this.selectedMutasi === Mutasi.kematian) {
            if (!hot.getSelected())
                return;

            this.selectedPenduduk = schemas.arrayToObj(hot.getDataAtRow(hot.getSelected()[0]), schemas.penduduk);
        }
    }

    mutasi(isMultiple: boolean): void {
        let hot = this.hots['penduduk'];
        let mutasiHot = this.hots['mutasi'];

        let data = this.hots['mutasi'].getSourceData();

        try {
            switch (this.selectedMutasi) {
                case Mutasi.pindahPergi:
                    hot.alter('remove_row', hot.getSelected()[0]);

                    mutasiHot.alter('insert_row', 0);
                    mutasiHot.setDataAtCell(0, 0, base64.encode(uuid.v4()));
                    mutasiHot.setDataAtCell(0, 1, this.selectedPenduduk.nik);
                    mutasiHot.setDataAtCell(0, 2, this.selectedPenduduk.nama_penduduk);
                    mutasiHot.setDataAtCell(0, 3, 'Pindah Pergi');
                    mutasiHot.setDataAtCell(0, 4,  this.selectedPenduduk.desa);
                    mutasiHot.setDataAtCell(0, 5, new Date());

                    break;
                case Mutasi.pindahDatang:
                    hot.alter('insert_row', 0);
                    hot.setDataAtCell(0, 0, base64.encode(uuid.v4()));
                    hot.setDataAtCell(0, 1, this.selectedPenduduk.nik);
                    hot.setDataAtCell(0, 2, this.selectedPenduduk.nama_penduduk);

                    mutasiHot.alter('insert_row', 0);
                    mutasiHot.setDataAtCell(0, 0, base64.encode(uuid.v4()));
                    mutasiHot.setDataAtCell(0, 1, this.selectedPenduduk.nik);
                    mutasiHot.setDataAtCell(0, 2, this.selectedPenduduk.nama_penduduk);
                    mutasiHot.setDataAtCell(0, 3, 'Pindah Datang');
                    mutasiHot.setDataAtCell(0, 4,  this.selectedPenduduk.desa);
                    mutasiHot.setDataAtCell(0, 5, new Date());
                    
                    break;
                case Mutasi.kematian:
                    hot.alter('remove_row', hot.getSelected()[0]);

                    mutasiHot.alter('insert_row', 0);
                    mutasiHot.setDataAtCell(0, 0, base64.encode(uuid.v4()));
                    mutasiHot.setDataAtCell(0, 1, this.selectedPenduduk.nik);
                    mutasiHot.setDataAtCell(0, 2, this.selectedPenduduk.nama_penduduk);
                    mutasiHot.setDataAtCell(0, 3, 'Kematian');
                    mutasiHot.setDataAtCell(0, 4, '-');
                    mutasiHot.setDataAtCell(0, 5, new Date());

                    break;
                case Mutasi.kelahiran:
                    hot.alter('insert_row', 0);
                    hot.setDataAtCell(0, 0, base64.encode(uuid.v4()));
                    hot.setDataAtCell(0, 1, this.selectedPenduduk.nik);
                    hot.setDataAtCell(0, 2, this.selectedPenduduk.nama_penduduk);
                   
                    mutasiHot.alter('insert_row', 0);
                    mutasiHot.setDataAtCell(0, 0, base64.encode(uuid.v4()));
                    mutasiHot.setDataAtCell(0, 1, '');
                    mutasiHot.setDataAtCell(0, 2, this.selectedPenduduk.nama_penduduk);
                    mutasiHot.setDataAtCell(0, 3, 'Kelahiran');
                    mutasiHot.setDataAtCell(0, 4, '-');
                    mutasiHot.setDataAtCell(0, 5, new Date());
                    break;
            }

            this.pageSaver.bundleData['mutasi'] = mutasiHot.getSourceData();
            
            if (!isMultiple)
                $('#mutasi-modal').modal('hide');

            this.toastr.success('Mutasi penduduk berhasil');
        }
        catch (exception) {
            this.toastr.error('Mutasi penduduk gagal');
        }
    }

    filterContent() {
        let hot = this.hots['penduduk'];
        var plugin = hot.getPlugin('hiddenColumns');
        var value = parseInt($('input[name=btn-filter]:checked').val());
        var fields = schemas.penduduk.map(c => c.field);
        var result = PageSaver.spliceArray(fields, SHOW_COLUMNS[value]);

        plugin.showColumns(this.resultBefore);
        plugin.hideColumns(result);

        hot.render();
        this.resultBefore = result;
    }

    initProdeskel(): void {
        let hot = this.hots['keluarga'];
        let penduduks = hot.getSourceData().map(p => schemas.arrayToObj(p, schemas.penduduk));

        let prodeskelWebDriver = new ProdeskelWebDriver();
        prodeskelWebDriver.openSite();
        prodeskelWebDriver.login(this.settingsService.get('prodeskelRegCode'), this.settingsService.get('prodeskelPassword'));
        prodeskelWebDriver.addNewKK(penduduks.filter(p => p.hubungan_keluarga == 'Kepala Keluarga')[0], penduduks);
    }

    keyupListener = (e) => {
        // Ctrl+s
        if (e.ctrlKey && e.keyCode === 83) {
            this.pageSaver.onBeforeSave();
            e.preventDefault();
            e.stopPropagation();
        }
        // Ctrl+p
        else if (e.ctrlKey && e.keyCode === 80) {
            this.showSurat(true);
            e.preventDefault();
            e.stopPropagation();
        }
    }
    
    trackColumns(oldColumns: any[], newColumns: any[]): any[] {
        let indexAtNewColumn: number = 0;
        let missingIndexes: any[] = [];

        for(let i=0; i<oldColumns.length; i++) {
            if(oldColumns[i] !== newColumns[indexAtNewColumn]) {
                missingIndexes.push(i);
                continue;
            }    

            indexAtNewColumn++;
        }

        return missingIndexes;
    }
    
    transformBundle(bundleData): any {
        let currentSchemas = {
            'penduduk': schemas.penduduk.map(e => e.field),
            'mutasi': schemas.mutasi.map(e => e.field),
            'log_surat': schemas.logSurat.map(e => e.field)
        };

        let keys = Object.keys(currentSchemas);

        keys.forEach(key => {
            if(!bundleData['data'][key] || !bundleData['columns'][key])
                return;

            let missingIndexes = this.trackColumns(bundleData['columns'][key], currentSchemas[key]);
            let data = bundleData['data'][key];
  
            for(let i=0; i<data.length; i++) {
                let dataItem = data[i];

                if(dataItem.length === currentSchemas[key].length)
                    continue;

                for(let j=0; j<missingIndexes.length; j++) {
                    let missingIndex = missingIndexes[j];

                    dataItem.splice(missingIndex, 1);
                }
            }
        });

        return bundleData;
    }
}
