import { Component, ApplicationRef, NgZone, HostListener, ViewContainerRef, OnInit, OnDestroy } from "@angular/core";
import { Router, ActivatedRoute } from "@angular/router";
import { ToastsManager } from 'ng2-toastr';
import { Progress } from 'angular-progress-http';
import { Subscription } from 'rxjs';
import { KeuanganUtils } from '../helpers/keuanganUtils';
import { Importer } from '../helpers/importer';
import { PersistablePage } from '../pages/persistablePage';
import { FIELD_ALIASES, fromSiskeudes, toSiskeudes } from '../stores/siskeudesFieldTransformer';
import { CATEGORIES, PenganggaranContentManager } from '../stores/siskeudesContentManager';

import DataApiService from '../stores/dataApiService';
import SiskeudesReferenceHolder from '../stores/siskeudesReferenceHolder';
import SiskeudesService from '../stores/siskeudesService';
import SharedService from '../stores/sharedService';
import SettingsService from '../stores/settingsService';

import schemas from '../schemas';
import TableHelper from '../helpers/table';
import SumCounterRAB from "../helpers/sumCounterRAB";
import titleBar from '../helpers/titleBar';
import PageSaver from '../helpers/pageSaver';

import * as $ from 'jquery';
import * as moment from 'moment';
import * as jetpack from 'fs-jetpack';
import * as fs from 'fs';
import * as path from 'path';

var Handsontable = require('../lib/handsontablep/dist/handsontable.full.js');

const SHOW_COLUMNS = [
    schemas.rab.filter(e => e.field !== 'id').map(e => e.field),
    ["kode_rekening", "kode_kegiatan", "uraian", "sumber_dana", "jumlah_satuan", "satuan", "harga_satuan", "anggaran"],
    ["kode_rekening", "kode_kegiatan", "uraian", "sumber_dana", "jumlah_satuan_pak", "satuan", "harga_satuan_pak", "anggaran_pak", "perubahan"],
];

enum TypesBelanja { kelompok = 2, jenis = 3, obyek = 4 }
enum JenisPosting { "Usulan APBDes" = 1, "APBDes Awal tahun" = 2, "APBDes Perubahan" = 3 }

@Component({
    selector: 'penganggaran',
    templateUrl: '../templates/penganggaran.html',
    host: {
        '(window:resize)': 'onResize($event)'
    }
})

export default class PenganggaranComponent extends KeuanganUtils implements OnInit, OnDestroy, PersistablePage {
    type = "penganggaran";
    subType = null;

    bundleSchemas = { kegiatan: schemas.kegiatan, rab: schemas.rab };

    hots: any = {};
    activeHot: any = {};
    sheets: any[];
    activeSheet: string;
    tableHelpers: any = {};

    initialDatasets: any = {};
    contentsPostingLog: any[] = [];
    statusPosting: any = {};
    
    year: string;
    kodeDesa: string;
    activePageMenu: string;

    dataReferences: SiskeudesReferenceHolder;
    contentSelection: any = {};
    desa: any = {};

    contentManager: PenganggaranContentManager;
    isExist: boolean;
    messageIsExist: string;
    kegiatanSelected: string;
    isObyekRABSub: boolean;

    anggaran: any;
    anggaranSumberdana: any = {};
    isAnggaranNotEnough: boolean;

    statusAPBDes: string;
    afterSaveAction: string;
    stopLooping: boolean;
    model: any = {};    
    tabActive: string;
    progress: Progress;
    progressMessage: string;

    afterChangeHook: any;
    afterRemoveRowHook: any;
    penganggaranSubscription: Subscription;
    routeSubscription: Subscription;
    pageSaver: PageSaver;
    modalSaveId;   
    resultBefore: any[];
    isEmptyRabSub: boolean;

    constructor(
        public dataApiService: DataApiService,
        public sharedService: SharedService,
        private siskeudesService: SiskeudesService,
        private appRef: ApplicationRef,
        private zone: NgZone,
        public router: Router,
        public toastr: ToastsManager,
        private route: ActivatedRoute,
        private vcr: ViewContainerRef,
    ) {
        super(dataApiService);
        this.toastr.setRootViewContainerRef(vcr);        
        this.pageSaver = new PageSaver(this);
        this.dataReferences = new SiskeudesReferenceHolder(siskeudesService);
    }

    ngOnInit() {
        titleBar.title('Data Penganggaran - ' + this.dataApiService.getActiveAuth()['desa_name']);
        titleBar.blue();

        this.resultBefore = [];
        this.isExist = false;
        this.isObyekRABSub = false;
        this.kegiatanSelected = '';
        this.initialDatasets = { rab: [], kegiatan: [] };
        this.model.tabActive = null;
        this.tabActive = 'posting';
        this.contentsPostingLog = [];
        this.statusPosting = { '1': false, '2': false, '3': false }
        this.sheets = ['kegiatan', 'rab'];
        this.activeSheet = 'kegiatan';
        this.modalSaveId = 'modal-save-diff';
        this.tableHelpers = { kegiatan: {}, rab: {} }
        this.pageSaver.bundleData = { kegiatan: [], rab: [] }
        let me = this;

        document.addEventListener('keyup', this.keyupListener, false);
        this.sheets.forEach(sheet => {
            let sheetContainer = document.getElementById('sheet-'+sheet);
            let inputSearch = document.getElementById('input-search-'+sheet);
            this.hots[sheet] = this.createSheet(sheetContainer, sheet);
            let tableHelper: TableHelper = new TableHelper(this.hots[sheet], inputSearch);
            tableHelper.initializeTableSearch(document, null);
            this.tableHelpers[sheet] = tableHelper;
        });        

        this.routeSubscription = this.route.queryParams.subscribe(async (params) => {
            this.year = params['year'];
            this.kodeDesa = params['kd_desa'];
            titleBar.title('Data Penganggaran '+ this.year+' - ' + this.dataApiService.getActiveAuth()['desa_name']);
            this.subType = this.year;

            var data = await this.siskeudesService.getTaDesa(this.kodeDesa);
            this.desa = data[0];
            
            this.contentManager = new PenganggaranContentManager(
                this.siskeudesService, this.desa, this.dataReferences, this.hots["rab"]["sumCounter"]);
            this.statusAPBDes = this.desa.status;
            this.setEditor();
            
            data = await this.contentManager.getContents();
            this.pageSaver.writeSiskeudesData(data);
            this.activeHot = this.hots['kegiatan'];

            this.sheets.forEach(sheet => {                        
                this.hots[sheet].loadData(data[sheet])
                
                if(sheet == 'rab'){
                    this.hots[sheet].sumCounter.calculateAll();
                    this.initialDatasets[sheet] = this.getSourceDataWithSums().map(c => c.slice());                    
                }
                else{
                    this.initialDatasets[sheet] = data[sheet].map(c => c.slice());                    
                }
                this.pageSaver.bundleData[sheet] = data[sheet].map(c => c.slice());  
            })

            data = await this.dataReferences.get("refSumberDana");
            let sumberDana = data.map(c => c.Kode);
            let rabSetting = schemas.rab.map(c => Object.assign({}, c));

            rabSetting.forEach(c => {
                if(c.field == "sumber_dana")
                    c['source'] = sumberDana;
            });                            

            this.hots['rab'].updateSettings({ columns: rabSetting })
            this.calculateAnggaranSumberdana();
            this.getReferences(me.kodeDesa);

            setTimeout(function () {                       
                me.hots['kegiatan'].render();
            }, 300);
        });
    }
    
    ngOnDestroy(): void {
        document.removeEventListener('keyup', this.keyupListener, false);
        this.sheets.forEach(sheet => {            
            this.tableHelpers[sheet].removeListenerAndHooks();
            if(sheet == 'rab'){
                if (this.afterRemoveRowHook)
                    this.hots['rab'].removeHook('afterRemoveRow', this.afterRemoveRowHook);            
                if (this.afterChangeHook)    
                    this.hots['rab'].removeHook('afterChange', this.afterChangeHook);
            }
            this.hots[sheet].destroy();  
        })

        this.routeSubscription.unsubscribe();
        titleBar.removeTitle();

        if(this.penganggaranSubscription)
            this.penganggaranSubscription.unsubscribe()
        
    } 

    forceQuit(): void {
        $('#modal-save-diff').modal('hide');
        this.router.navigateByUrl('/');
    }

    afterSave(): void {
        if (this.afterSaveAction == "home")
            this.router.navigateByUrl('/');
        else if (this.afterSaveAction == "quit")
            this.sharedService.getApp().quit();
    }

    createSheet(sheetContainer, sheet): any {
        let me = this;
        let config = {
            data: [],
            topOverlay: 34,

            rowHeaders: true,
            colHeaders: schemas.getHeader(schemas[sheet]),
            columns: schemas[sheet],

            colWidths: schemas.getColWidths(schemas[sheet]),
            rowHeights: 23,

            columnSorting: true,
            sortIndicator: true,
            hiddenColumns: {
                columns: schemas[sheet].map((c, i) => { return (c.hiddenColumn == true) ? i : '' }).filter(c => c !== ''),
                indicators: true
            },

            renderAllRows: false,
            outsideClickDeselects: false,
            autoColumnSize: false,
            search: true,
            schemaFilters: true,
            contextMenu: ['undo', 'redo', 'remove_row'],
            dropdownMenu: ['filter_by_condition', 'filter_action_bar']
        }

        let result = new Handsontable(sheetContainer, config);

        if(sheet == 'kegiatan')
            return result;
        
        result['sumCounter'] = new SumCounterRAB(result);

        this.afterRemoveRowHook = (index, amount) => {
            result.sumCounter.calculateAll();
            result.render();
        }
        result.addHook('afterRemoveRow', this.afterRemoveRowHook);

        this.afterChangeHook = (changes, source) => {
            if (source === 'edit' || source === 'undo' || source === 'autofill') {
                var rerender = false;
                var indexAnggaran = [4, 5, 7, 9, 11];

                if (me.stopLooping) {
                    me.stopLooping = false;
                    changes = [];
                }

                changes.forEach(function (item) {
                    if(me.activeSheet !== 'rab')
                        return;
                    var row = item[0],
                        col = item[1],
                        prevValue = item[2],
                        value = item[3];

                    if (indexAnggaran.indexOf(col) !== -1) {
                        if (col == 5 && me.statusAPBDes == 'AWAL')
                            result.setDataAtCell(row, 9, value)

                        let rowData = result.getDataAtRow(row);
                        let id = rowData[0];
                        let kodeRekening = rowData[1];
                        let sumberDana = rowData[4];
                        let isValidAnggaran = true;
                        let jumlahSatuan = (me.statusAPBDes == 'AWAL') ? 5 : 9;
                        let hargaSatuan = (me.statusAPBDes == 'AWAL') ? 7 : 11;

                        if (kodeRekening && kodeRekening.startsWith('5.')) {
                            let anggaran = rowData[jumlahSatuan] * rowData[hargaSatuan];
                            let prevAnggaran = result.sumCounter.sums.awal[id];
                            let sisaAnggaran = me.anggaranSumberdana.anggaran[sumberDana] - (me.anggaranSumberdana.terpakai[sumberDana] - prevAnggaran);

                            if (col == 4) {
                                let prevAnggaran = me.anggaranSumberdana.anggaran[prevValue];
                                let anggaran = me.anggaranSumberdana.anggaran[sumberDana];

                                if (prevAnggaran > anggaran) {
                                    me.toastr.error('Pendapatan Untuk Sumberdana ' + sumberDana + ' Tidak Mencukupi !', '');
                                    isValidAnggaran = false;
                                }
                            }
                            else {
                                if (anggaran > sisaAnggaran) {
                                    me.toastr.error('Pendapatan Untuk Sumberdana ' + sumberDana + ' Tidak Mencukupi !', '');
                                    isValidAnggaran = false;
                                }
                            }
                        }
                        else {
                            let anggaran = rowData[jumlahSatuan] * rowData[hargaSatuan];
                            let prevAnggaran = result.sumCounter.sums.awal[kodeRekening];
                            let perubahanAnggaran = anggaran - prevAnggaran;
                            let newAnggaran = me.anggaranSumberdana.anggaran[sumberDana] + perubahanAnggaran;

                            if (col == 4) {
                                let sisaAnggaran = me.anggaranSumberdana.anggaran[prevValue] - anggaran;
                                let anggaranTerpakai = me.anggaranSumberdana.terpakai[prevValue];

                                if (sisaAnggaran < anggaranTerpakai) {
                                    me.toastr.error('Pendapatan tidak bisa dikurangi', '');
                                    isValidAnggaran = false;
                                }

                            }
                            else {
                                if (newAnggaran < me.anggaranSumberdana.terpakai[sumberDana]) {
                                    me.toastr.error('Pendapatan tidak bisa dikurangi', '');
                                    isValidAnggaran = false;
                                }
                            }
                        }

                        if (isValidAnggaran) {
                            me.calculateAnggaranSumberdana();
                            rerender = true;
                            me.stopLooping = false;
                        }
                        else {
                            result.setDataAtCell(row, col, prevValue)
                            me.stopLooping = true;
                        }
                    }

                    if (col == 6 && me.statusAPBDes == 'AWAL') {
                        result.setDataAtCell(row, 10, value)
                    }
                    if (col == 7 && me.statusAPBDes == 'AWAL') {
                        result.setDataAtCell(row, 11, value)
                    }
                    if (col == 10 && me.statusAPBDes == 'PAK') {
                        result.setDataAtCell(row, 6, value)
                    }
                });

                if (rerender) {
                    result.sumCounter.calculateAll();
                    result.render();
                }
            }
        }
        result.addHook('afterChange', this.afterChangeHook);
        return result;
    }

    onResize(event): void {
        let that = this;
        setTimeout(function () {
            that.activeHot.render()
        }, 200);
    }  

    setEditor(): void {
        let setEditor = { awal: [5, 6, 7], pak: [9, 10, 11] }
        let newSetting = schemas.rab;
        let valueAwal, valuePak;

        if (this.statusAPBDes == 'PAK') {
            valueAwal = false;
            valuePak = 'text';
        }
        else {
            valueAwal = 'text';
            valuePak = false;
        }

        newSetting.map((c, i) => {
            if (setEditor.awal.indexOf(i) !== -1)
                c['editor'] = valueAwal;
            if (setEditor.pak.indexOf(i) !== -1)
                c['editor'] = valuePak;
        })

        this.hots['rab'].updateSettings({ columns: newSetting })
        this.hots['rab'].render();
    }

    getSourceDataWithSums(): any[] {
        let data = this.hots['rab'].sumCounter.dataBundles.map(c => schemas.objToArray(c, schemas.rab));
        return data;
    }

    getCurrentUnsavedData(): any {
        return {
            kegiatan: this.hots['kegiatan'].getSourceData(),
            rab: this.hots['rab'].getSourceData()
        }
    }

    saveContentToServer(data) {
        this.progressMessage = 'Menyimpan Data';
        this.pageSaver.saveSiskeudesData(data);
    }

    progressListener(progress: Progress) {
        this.progress = progress;
    }

    async getContentPostingLog() {
        let data = await this.siskeudesService.getPostingLog(this.kodeDesa);        
        this.contentsPostingLog = data;
        this.setStatusPosting();
    }

    getJenisPosting(value) {
        let num = parseInt(value);
        return JenisPosting[num];
    }

    saveContent() {
        $('#modal-save-diff').modal('hide');             
        this.hots['rab'].sumCounter.calculateAll();
        
        let sourceDatas = {
            kegiatan: this.hots['kegiatan'].getSourceData(),
            rab: this.getSourceDataWithSums(),
        };

        let me = this; 
        let diffs = this.pageSaver.trackDiffs(this.initialDatasets, sourceDatas)

        this.contentManager.saveDiffs(diffs, response => {
            if (response.length == 0) {
                this.toastr.success('Penyimpanan Berhasil!', '');
                
                this.siskeudesService.updateSumberdanaTaKegiatan(this.desa.kode_desa, response => {
                    CATEGORIES.forEach(category => {
                        category.currents.map(c => c.value = '');
                    })
    
                    this.contentManager.getContents().then(data => {    
                        
                        this.pageSaver.writeSiskeudesData(data);
                        this.saveContentToServer(data);

                        this.sheets.forEach(sheet => {                        
                            this.hots[sheet].loadData(data[sheet])
                            
                            if(sheet == 'rab'){
                                this.hots['rab'].sumCounter.calculateAll();
                                this.initialDatasets[sheet] = this.getSourceDataWithSums().map(c => c.slice());
                            }
                            else
                                this.initialDatasets[sheet] = data[sheet].map(c => c.slice());
    
                            if(sheet == this.activeSheet){
                                setTimeout(function() {
                                    me.hots[me.activeSheet].render();
                                }, 300);
                            }
                        })
                        this.afterSave();
                    });                
                })

                
            }
            else
                this.toastr.error('Penyimpanan Gagal!', '');
        });
    }

    postingAPBDes(model) {
        let isFilled = this.validateForm(model);
        if (isFilled) {
            this.toastr.error('Wajib Mengisi Semua Kolom Yang Bertanda (*)')
            return;
        }

        model['tahun'] = this.year;
        model['tanggal_posting'] = model.tanggal_posting.toString();

        this.siskeudesService.postingAPBDes(this.kodeDesa, model, this.statusAPBDes, response => {
            if (response.length == 0) {
                this.toastr.success('Penyimpanan Berhasil!', '');
                this.getContentPostingLog();
            }
            else
                this.toastr.error('Penyimpanan Gagal!', '');
        })
    }

    setStatusPosting() {
        Object.keys(this.statusPosting).forEach(val => {
            if (this.contentsPostingLog.find(c => c.kode_posting == val))
                this.statusPosting[val] = true;
            else
                this.statusPosting[val] = false;
        })
    }

    setLockPosting(setLock) {
        let table = 'Ta_AnggaranLog';
        let contents = [];
        let bundle = {
            insert: [],
            update: [],
            delete: []
        };

        if (!this.contentsPostingLog || this.contentsPostingLog.length < 1)
            return;

        this.contentsPostingLog.forEach(content => {
            if (!content || content.kunci == setLock)
                return;

            if (!this.model[content.kode_posting])
                return;

            contents.push(content);
        });

        if (contents.length == 0)
            return;

        contents.forEach(content => {
            let whereClause = { kode_posting: content.kode_posting };
            let data = { kunci: setLock }

            bundle.update.push({ [table]: { whereClause: whereClause, data: toSiskeudes(data, 'posting_log') } })
        });

        this.siskeudesService.saveToSiskeudesDB(bundle, null, response => {
            if (response.length == 0) {
                this.toastr.success('Penyimpanan Berhasil!', '');

                this.getContentPostingLog();
            }
            else
                this.toastr.error('Penyimpanan Gagal!', '');
        });
    }

    deletePosting() {
        let contents = [];
        let isLocked = false;
        let bundle = {
            insert: [],
            update: [],
            delete: []
        };

        if (!this.contentsPostingLog || this.contentsPostingLog.length == 0)
            return;

        this.contentsPostingLog.forEach(content => {
            if (!this.model[content.kode_posting])
                return;

            if (content.kunci) {
                isLocked = true;
                return;
            }

            contents.push(content);
        });

        if (isLocked) {
            this.toastr.error('Penghapusan Gagal Karena Status Masih Terkunci!', '');
            return;
        }

        if (contents.length == 0)
            return;

        contents.forEach(content => {
            let whereClause = { KdPosting: content.kode_posting, Kd_Desa: this.kodeDesa };

            bundle.delete.push({ 'Ta_AnggaranRinci': { whereClause: whereClause, data: {} } })
            bundle.delete.push({ 'Ta_AnggaranLog': { whereClause: whereClause, data: {} } })
            bundle.delete.push({ 'Ta_Anggaran': { whereClause: whereClause, data: {} } })
        });

        this.siskeudesService.saveToSiskeudesDB(bundle, null, response => {
            if (response.length == 0) {
                this.toastr.success('Penyimpanan Berhasil!', '');

                this.getContentPostingLog();
            }
            else
                this.toastr.error('Penyimpanan Gagal!', '');
        })

    }

    selectTab(sheet): void {
        let that = this;
        this.isExist = false;
        this.activeSheet = sheet;
        this.activeHot = this.hots[sheet];

        if(sheet == 'rab'){
            let bidang = [], kegiatan = [];
            let sourceData =  this.hots['kegiatan'].getSourceData().map(c =>schemas.arrayToObj(c, schemas.kegiatan));
            sourceData.forEach(row => {
                let findBidang = bidang.find(c => c.kode_bidang == row.kode_bidang);
                if(!findBidang)
                    bidang.push({ kode_bidang: row.kode_bidang, nama_bidang: row.nama_bidang });
                kegiatan.push({ kode_bidang: row.kode_bidang, kode_kegiatan: row.kode_kegiatan, nama_kegiatan: row.nama_kegiatan })
            });
            this.dataReferences['bidang'] = bidang.map(c => Object.assign({}, c));
            this.dataReferences['kegiatan'] = kegiatan.map(c => Object.assign({}, c));
        }

        setTimeout(function () {
            that.activeHot.render();
        }, 500);
    }

    checkAnggaran(type, value) {
        if (this.model.category !== 'belanja')
            return;

        if (type == 'anggaran')
            this.anggaran = (!value) ? 0 : value;

        if (this.model.sumber_dana && this.model.sumber_dana !== "null") {
            let anggaran = this.anggaranSumberdana.anggaran[this.model.sumber_dana];
            let sisaAnggaran = anggaran - this.anggaranSumberdana.terpakai[this.model.sumber_dana];

            if (this.anggaran == 0 && sisaAnggaran == 0) {
                this.isAnggaranNotEnough = false;
                return;
            }

            if (this.anggaran < sisaAnggaran)
                this.isAnggaranNotEnough = false;
            else
                this.isAnggaranNotEnough = true;
        }
    }

    openAddRowDialog(): void {
        this.contentSelection['rabSubObyek'] = [];
        this.isObyekRABSub=false;
        if(this.activeSheet == 'rab'){
            let selected = this.activeHot.getSelected();
            let category = 'pendapatan';
            let sourceData = this.hots['rab'].getSourceData();

            if (selected) {
                let data = this.hots['rab'].getDataAtRow(selected[1]);
                let currentCategory = CATEGORIES.find(c => c.code.slice(0, 2) == data[1].slice(0, 2));
            }

            this.model.category = category;
            this.setDefaultValue();
            this.categoryOnChange(category);
        }
        else {
            this.setDefaultValue();
        }
        $('#modal-add-' + this.activeSheet).modal('show');
        
    }

    openPostingDialog() {
        this.contentsPostingLog = [];
        this.model = {};
        this.zone.run(() => {
            this.model.tabActive = 'posting-apbdes';
        });

        $('#modal-posting-apbdes').modal('show');
        this.getContentPostingLog();
    }


    setDefaultValue(): void {
        this.isExist = false;
        this.isAnggaranNotEnough = false;
        let model = [];

        if(this.activeSheet == 'kegiatan'){
            this.model.kode_bidang = null;
            this.model.kode_kegiatan = null;
        }

        if (this.model.category == 'belanja') {
            model = ['kode_bidang', 'kode_kegiatan', 'jenis', 'obyek','sumber_dana'];
        }
        else if (this.model.category !== 'belanja' && this.model.category) {
            model = ['kelompok', 'jenis', 'obyek' , 'sumber_dana'];
        }

        this.model.jumlah_satuan = 0;
        this.model.biaya = 0;
        this.model.uraian = '';
        this.model.harga_satuan = 0;

        model.forEach(c => {
            this.model[c] = null;
        });
    }

    addRow(data): void {
        let me = this;
        let position = 0;
        let sourceData = this.activeHot.getSourceData().map(c => schemas.arrayToObj(c, schemas[this.activeSheet]));
        let contents = [], lastCode, lastCodeRabSub;

        let positions = { kelompok: 0, jenis: 0, obyek: 0, kode_kegiatan: 0, kode_bidang:0, akun: 0, rab_sub: 0 }
        let types = ['kelompok', 'jenis', 'obyek'];
        let currentKodeKegiatan = '', oldKodeKegiatan = '', isSmaller = false;
        let same = [];
        let isAkunAdded = false, isBidangAdded= false, isKegiatanAdded = false;
        let category = CATEGORIES.find(c => c.name == data.category);

        if (this.isAnggaranNotEnough)
            return;

        //add row for kegiatan
        if(this.activeSheet == 'kegiatan'){
            let result = [];

            sourceData.forEach((content, i) => {
                if (data['kode_kegiatan'] > content.kode_kegiatan)
                    position = i + 1;
            });

            data['id'] = `${data.kode_bidang}_${data.kode_kegiatan}`;            
            data['nama_bidang'] = this.dataReferences['refBidang'].find(c => c.kode_bidang == data.kode_bidang).nama_bidang;
            data['nama_kegiatan'] = this.dataReferences['refKegiatan'].find(c => c.kode_kegiatan == data.kode_kegiatan).nama_kegiatan;            
            result = schemas.objToArray(data, schemas.kegiatan);

            this.activeHot.alter("insert_row", position);
            this.activeHot.populateFromArray(position, 0, [result], position, result.length-1, null, 'overwrite');            
            this.activeHot.selectCell(position, 0, position, 5, true, true);

            setTimeout(function() {
                me.activeHot.render();
            }, 300);

            return;
        }

        lastCode = data.obyek + '00';
        lastCodeRabSub = data.obyek+'00';
        for (let i = 0; i < sourceData.length; i++) {
            let content = sourceData[i];
            let dotCount = (content.kode_rekening.slice(-1) == '.') ? content.kode_rekening.split('.').length - 1 : content.kode_rekening.split('.').length;

            //Berhenti mengulang saat menambahkan pendaptan, jika kode rekening dimulai dengan 5
            if (content.kode_rekening == '5.' && data.category == 'pendapatan')
                break;
            
            //Cek apakah kode rekening 4. /5. /6. sudah ada
            let code = (category.name == 'belanja') ? data['jenis'] : data['kelompok'];
            if(code.startsWith(content.kode_rekening) && dotCount == 1){
                if(content.kode_rekening == category.code){
                    isAkunAdded = true;
                }
            }
            
            if (data.category == 'pendapatan' || data.category == 'pembiayaan') {
                if(category.code > content.kode_rekening)
                positions.akun = i+1;

                if (data.category == 'pembiayaan' && !content.kode_rekening.startsWith('6.'))
                    continue;

                if (data['kelompok'] >= content.kode_rekening){
                    positions.kelompok = i + 1;
                }

                let isJenis = (data['jenis'] < content.kode_rekening);
                let isParent = (content.kode_rekening.startsWith(data['kelompok']));

                if (isJenis && isParent && dotCount == 3)
                    positions.jenis = i;

                if (!isJenis && isParent) {
                    positions.jenis = i + 1;
                }

                let isObyek = (data['obyek'] > content.kode_rekening);
                isParent = (content.kode_rekening.startsWith(data['jenis']));

                if (isObyek && isParent) {
                    positions.obyek = i + 1;
                    isSmaller = true;
                }

                if (!isObyek && isParent && !isSmaller)
                    positions.obyek = i + 1;

                if (content.kode_rekening == data[TypesBelanja[dotCount]])
                    same.push(TypesBelanja[dotCount]);
                
                if(content.kode_rekening.startsWith(data.obyek)){
                    position = i+1;

                    if(dotCount == 5)
                        lastCode = content.kode_rekening;                    
                }

            }
            else {
                //jika row selanjutnya adalah pembiayaan berhenti mengulang
                if(content.kode_rekening.startsWith('6.'))
                    break;

                if(content.kode_rekening.startsWith('4.'))
                    position = i + 1;
                
                let dotCountBidOrKeg = (content.kode_kegiatan.slice(-1) == '.') ? content.kode_kegiatan.split('.').length - 1 : content.kode_kegiatan.split('.').length;
                if(!content.kode_kegiatan || content.kode_kegiatan != ""){
                    if(data.kode_bidang == content.kode_kegiatan)
                        isBidangAdded = true;
                    else if(data.kode_kegiatan == content.kode_kegiatan)
                        isKegiatanAdded = true;
                }
                if(content.kode_rekening == '5.')
                    positions.akun = i+1;

                if(data.kode_bidang > content.id)
                    positions.kode_bidang = i+1;

                if(data.kode_kegiatan > content.id)
                    positions.kode_kegiatan = i+1;

                if(category.code > content.kode_rekening)
                    positions.akun = i+1;

                if(!isKegiatanAdded){
                    if(dotCount > 1 && dotCount < 4)
                        positions[types[dotCount - 1]]
                    else if(data.obyek > content.kode_rekening)
                        position = i + 1;
                } 
                                
                if (data.kode_kegiatan !== content.kode_kegiatan) 
                    continue;

                if (content.kode_rekening == data[TypesBelanja[dotCount]])
                    same.push(TypesBelanja[dotCount]);

                if (content.kode_rekening == '' || !content.kode_rekening.startsWith('5.')) 
                    continue;

                let isJenis = (data['jenis'] <= content.kode_rekening && dotCount == 3);

                if (isJenis && dotCount == 3)
                    positions.jenis = i;

                if (!isJenis && data['jenis'] >= content.kode_rekening)
                    positions.jenis = i + 1;

                let isObyek = (data['obyek'] >= content.kode_rekening);
                let isParent = (content.kode_rekening.startsWith(data['jenis']));


                if (isObyek && isParent) {
                    positions.obyek = i + 1;
                    isSmaller = true;
                }

                if (!isObyek && isParent && !isSmaller)
                    positions.obyek = i + 1;

                if (dotCount >= 5 && data.kode_kegiatan == content.kode_kegiatan && content.kode_rekening.startsWith(data.obyek) ){
                    if(dotCount == 5){
                        if(content.kode_rekening.startsWith('5.1.3'))
                            lastCodeRabSub = content.kode_rekening;
                        else
                            lastCode = content.kode_rekening;
                    }
                    if(dotCount == 6){
                        lastCode = content.kode_rekening;
                    }
                }

                if(content.kode_rekening.startsWith(data.obyek) && data.kode_kegiatan == content.kode_kegiatan)
                    positions.obyek = i+1;

            }
        }
        
        if(!isAkunAdded)
            contents.push([category.code,'',category.name.toUpperCase()])

        //jika bidang belum ditambahkan push bidang
        if(!isBidangAdded && category.name == 'belanja'){
            let bidang = this.dataReferences['bidang'].find(c => c.kode_bidang == data.kode_bidang);
            contents.push(['',bidang.kode_bidang, bidang.nama_bidang])
        }

        //jika kegiatan belum ditambahkan push kegiatan
        if(!isKegiatanAdded && category.name == 'belanja'){
            let kegiatan = this.dataReferences['kegiatan'].find(c => c.kode_kegiatan == data.kode_kegiatan)
            contents.push(['',kegiatan.kode_kegiatan, kegiatan.nama_kegiatan])
        }

        //jika category == belanja, hapus kelompok pada types
        types = (data.category == 'belanja') ? types.slice(1) : types;

        types.forEach(value => {
            //jika rincian sudah ditambahkan pada 1 kode rekening, skip
            if (same.indexOf(value) !== -1) return;
            let content = this.dataReferences[value].find(c => c[0] == data[value]).slice();
            
            if(content && data['kode_kegiatan'])
                content[1] = data['kode_kegiatan'];
            //push kelompok/ jenis/ obyek
            content ? contents.push(content) : '';
        });

        if(!isAkunAdded){
            position = positions.akun;
        }
        else if(category.name == 'belanja' && same.length == 0){
            if(isAkunAdded && !isBidangAdded)
                position = positions.kode_bidang;
            else if(isBidangAdded && !isKegiatanAdded)
                position = positions.kode_kegiatan; 
            else if(isKegiatanAdded && positions.jenis == 0)
                position = positions.kode_kegiatan;
            else if(isKegiatanAdded && positions.jenis != 0)
                position = positions.jenis;
        } 
        else if(same.length !== 3){
            position = (same.length == 0 && positions[types[0]] == 0) ? position  : 
            (data.category == 'belanja' && same.length == 2) ? positions[types[same.length-1]] : positions[types[same.length]];  
        }          

        let results = [];
        let fields = CATEGORIES.find(c => c.name == data.category).fields;
        let fieldsSiskeudes = FIELD_ALIASES.rab;
        let reverseAliases = {};

        Object.keys(fieldsSiskeudes).forEach(key => {
            reverseAliases[fieldsSiskeudes[key]] = key;
        });

        data['jumlah_satuan_pak'] = data['jumlah_satuan'];
        data['harga_satuan_pak'] = data['harga_satuan'];
        data['kode_rekening'] = this.getNewCode(lastCode);

        if (me.statusAPBDes == 'PAK') {
            data['jumlah_satuan'] = '0';
            data['harga_satuan'] = '0';
        }
        if(data.obyek.startsWith('5.1.3')){
            if(this.model.is_add_rabsub){
                let rabSubCode = this.getNewCode(lastCodeRabSub);
                data['kode_rekening'] = this.getNewCode(rabSubCode+'.00');
                
                contents.push([rabSubCode, data.kode_kegiatan, data.uraian_rab_sub])
            }
        }
        
        fields[fields.length - 1].forEach(c => {
            let key = reverseAliases[c];
            let value = (data[key]) ? data[key] : "";

            if(c == 'Obyek_Rincian' || c == 'Kode_Rincian')
                value = data.kode_rekening;
            
            results.push(value)
        });
        //push rincian
        contents.push(results);

        let start = position, end = 0;
        contents.forEach((content, i) => {
            let newPosition = position + i;
            this.activeHot.alter("insert_row", newPosition);
            end = newPosition;

            let row = this.contentManager.generateRabId(content, data.kode_kegiatan);
            this.hots['rab'].populateFromArray(newPosition, 0, [row], newPosition, row.length - 1, null, 'overwrite');
        });        
        
        this.activeHot.selectCell(start, 0, end, 7, true, true);
        setTimeout(function () {
            if(me.hots['rab'].sumCounter){
                me.hots['rab'].sumCounter.calculateAll();
                me.calculateAnggaranSumberdana();
            }
            me.activeHot.render();
        }, 300);  
        this.model = {};
        this.setDefaultValue();      
    }

    getNewCode(lastCode){
        let splitLastCode = lastCode.slice(-1) == '.' ? lastCode.slice(0, -1).split('.') : lastCode.split('.');
        let digits = splitLastCode[splitLastCode.length - 1];
        let newCode = splitLastCode.slice(0, splitLastCode.length - 1).join('.') + '.' + ("0" + (parseInt(digits) + 1)).slice(-2);
        return newCode
    }

    addOneRow(model): void {
        let isValid = this.validateForm(model);

        if(!isValid){
            this.addRow(model);
            $("#modal-add-"+this.activeSheet).modal("hide");
        }
    }

    addOneRowAndAnother(model): void {
        let isValid = this.validateForm(model);

        if(!isValid)
            this.addRow(model);        
    }


    validateIsExist(value, message) {
        let sourceData = this.hots[this.activeSheet].getSourceData().map(c => schemas.arrayToObj(c, schemas[this.activeSheet]));
        this.messageIsExist = message;

        if(this.activeSheet == 'kegiatan'){
            if (sourceData.length < 1)
                this.isExist = false;
    
            for (let i = 0; i < sourceData.length; i++) {
                if (sourceData[i].kode_kegiatan == value) {
                    this.zone.run(() => {
                        this.isExist = true;
                    })
                    break;
                }
                this.isExist = false;
            }
        }        
    }

    categoryOnChange(value): void {
        this.isExist = false;
        this.isAnggaranNotEnough = false;
        this.anggaran = 0;
        this.kegiatanSelected = '';
        this.model.category = value;
        this.contentSelection = {};
        this.setDefaultValue();

        switch (value) {
            case "pendapatan": 
                Object.assign(this.dataReferences, this.dataReferences['pendapatan']);
                break;

            case "belanja":
                Object.assign(this.dataReferences, this.dataReferences['belanja']);
                break;

            case "pembiayaan":                        
                Object.assign(this.dataReferences, this.dataReferences['pembiayaan']);
                let value = this.dataReferences['kelompok'].filter(c => c[0] == '6.1.');
                this.dataReferences['kelompok'] = value;
                break;
        }

    }

    selectedOnChange(selector, value) {
        let data = [];
        let results = [];

        if(this.activeSheet == 'kegiatan'){
            this.contentSelection['refKegiatan'] = this.dataReferences['refKegiatan'].filter(c => c.kode_kegiatan.startsWith(value));
        }
        else {
            if(this.model.category !== 'belanja'){
                this.isExist = false;
                let type = (selector == 'kelompok') ? 'jenis' : 'obyek';

                if (selector == 'kelompok') {
                    this.setDefaultValue();
                    if (value !== null || value != 'null')
                        this.model.kelompok = value;
                }

                data = this.dataReferences[type];
                results = data.filter(c => c[0].startsWith(value));
                let ucFirst = type.charAt(0).toUpperCase() + type.slice(1)
                this.contentSelection['content' + ucFirst] = results;
            }
            else {
                switch (selector) {
                    case "bidang":
                        this.isObyekRABSub = false;
                        this.contentSelection = {};
                        this.setDefaultValue();
                        this.kegiatanSelected = '';

                        if (value !== null || value != 'null')
                            this.model.kode_bidang = value;

                        this.contentSelection['contentKegiatan'] = [];
                        data = this.dataReferences['kegiatan'].filter(c => c.kode_bidang == value);
                        this.contentSelection['contentKegiatan'] = data;
                        break;

                    case "kegiatan":
                        this.kegiatanSelected = value;

                        this.contentSelection['obyekAvailable'] = [];
                        let sourceData = this.hots['rab'].getSourceData().map(c => schemas.arrayToObj(c, schemas.rab));
                        let contentObyek = [];
                        let currentCodeKeg = '';

                        sourceData.forEach(content => {
                            if(content.kode_kegiatan !== "" && content.kode_kegiatan.startsWith(value)){
                                let lengthCodeRek = (content.kode_rekening.slice(-1) == '.') ? content.kode_rekening.split('.').length - 1 : content.kode_rekening.split('.').length;
                                if (lengthCodeRek == 4)
                                    contentObyek.push(content);
                            }
                        });

                        this.contentSelection['obyekAvailable'] = contentObyek.map(c => schemas.objToArray(c, schemas.rab));
                        break;

                    case "jenis":
                        this.contentSelection['contentObyek'] = [];
                        data = this.dataReferences['belanja']['obyek'].filter(c => c[0].startsWith(value));
                        this.contentSelection['contentObyek'] = data;
                        this.zone.run(() => {
                           if(!value.startsWith('5.1.3')) 
                            this.isObyekRABSub = false;                            
                        });
                        break;

                    case "obyek":
                        let currentKdKegiatan = '';
                        this.contentSelection['rabSubAvailable'] = [];

                        if (value.startsWith('5.1.3.')) {
                            this.zone.run(()=> {
                                this.isObyekRABSub = true;
                            })
                              
                            let sourceData = this.hots['rab'].getSourceData().map(c => schemas.arrayToObj(c, schemas.rab));
                            let results = [];

                            sourceData.forEach(content => {
                                if(content.kode_rekening !== "" && content.kode_rekening.startsWith(value)){
                                    let lengthCodeRek = (content.kode_rekening.slice(-1) == '.') ? content.kode_rekening.split('.').length - 1 : content.kode_rekening.split('.').length;
                                    if (lengthCodeRek == 5)
                                        results.push(content);
                                }
                            });
                            this.contentSelection['rabSubAvailable'] = results.map(c => schemas.objToArray(c, schemas.rab));
                            break;
                        }
                        this.isObyekRABSub = false;
                        break;
                }
            }
        }
    }

    rabSubValidate(value){
        let content = [];
        this.isObyekRABSub = false;
        this.contentSelection['rabSubObyek'] = [];
        this.model.is_add_rabsub = false;
        this.isEmptyRabSub = true;

        if(value.startsWith('5.1.3')){
            let sourceData = this.hots['rab'].getSourceData().map(c => schemas.arrayToObj(c, schemas.rab));

            sourceData.forEach(row => {
                if(row.kode_kegiatan == this.model.kode_kegiatan){
                    let dotCount = row.kode_rekening.slice(-1) == '.' ? row.kode_rekening.split('.').length - 1 : row.kode_rekening.split('.').length;
                    
                    if(dotCount == 5 && row.kode_rekening.startsWith(value)){
                        content.push(row);
                    }
                }
            });

            this.contentSelection['rabSubObyek'] = content;
            this.isObyekRABSub = true;
            this.isEmptyRabSub = false;
            if(content.length == 0){
                this.model.is_add_rabsub = true;
                this.isEmptyRabSub = true;
            } 
        }
        
    }

    reffTransformData(data, fields, currents, results) {
        let keys = Object.keys(results)
        currents.map(c => c.value = "");
        data.forEach(content => {
            fields.forEach((field, idx) => {
                let res = [];
                let current = currents[idx];

                for (let i = 0; i < field.length; i++) {
                    let data = (content[field[i]]) ? content[field[i]] : '';
                    res.push(data)
                }

                if (current.value !== content[current.fieldName]) results[keys[idx]].push(res);
                current.value = content[current.fieldName];
            })
        });
        return results;
    }

    getReferences(kodeDesa): void {
        this.dataReferences['rabSub'] = { rabSubBidang: [], rabSubKegiatan: [], rabSubObyek: [] };
        let category = CATEGORIES.find(c => c.code == '4.')
        this.getReferencesByCode(category, pendapatan => {                
            this.dataReferences['pendapatan'] = pendapatan;
            let category = CATEGORIES.find(c => c.code == '5.')

            this.getReferencesByCode(category, pendapatan => {  
                this.dataReferences['belanja'] = pendapatan;                    
                let category = CATEGORIES.find(c => c.code == '6.')

                this.getReferencesByCode(category, pendapatan => { 
                    this.dataReferences['pembiayaan'] = pendapatan; 
                    
                    this.dataReferences.get("refBidang").then(data =>{
                        this.dataReferences['refBidang'] = data.map(c => { c['kode_bidang'] = kodeDesa + c.kode_bidang; return c });

                        this.dataReferences.get("refKegiatan").then(data => {
                            this.dataReferences['refKegiatan'] =  data.map(c => { c['kode_kegiatan'] = kodeDesa + c.id_kegiatan; return c });

                            this.siskeudesService.getTaBidangAvailable(kodeDesa, data => {
                                this.dataReferences['bidangAvailable'] = data;
                            })
                        }) 
                    })
                })
            })
        })
    }

    getReferencesByCode(category,callback){
         this.siskeudesService.getRefRekByCode(category.code, data => {
            let returnObject = (category.name != 'belanja') ? { kelompok: [], jenis: [], obyek: [] } : { jenis: [], obyek: [] };
            let endSlice = (category.name != 'belanja') ? 4 : 5;
            let startSlice = (category.name != 'belanja') ? 1 : 3;
            let fields = category.fields.slice(startSlice, endSlice);
            let currents = category.currents.slice(startSlice, endSlice);
            let results = this.reffTransformData(data, fields, currents, returnObject);
            callback(results)
        })
    }

    calculateAnggaranSumberdana() {
        let sourceData = this.hots['rab'].getSourceData().map(c => schemas.arrayToObj(c, schemas.rab));
        let results = { anggaran: {}, terpakai: {} }

        this.dataReferences["refSumberDana"].forEach(item => {
            results.anggaran[item.Kode] = 0;
            results.terpakai[item.Kode] = 0;
        });

        sourceData.forEach(row => {
            if (!row.kode_rekening)
                return;

            let dotCount = row.kode_rekening.slice(-1) == '.' ? row.kode_rekening.split('.').length - 1 : row.kode_rekening.split('.').length;

            if (dotCount == 6 && row.kode_rekening.startsWith('5.1.3')) {
                let anggaran = row.jumlah_satuan * row.harga_satuan;
                results.terpakai[row.sumber_dana] += anggaran;
            }

            if (dotCount !== 5)
                return;

            if (row.kode_rekening.startsWith('6.') || row.kode_rekening.startsWith('4.')) {
                let anggaran = row.jumlah_satuan * row.harga_satuan;
                results.anggaran[row.sumber_dana] += anggaran;
            }
            else if (!row.kode_rekening.startsWith('5.1.3')) {
                let anggaran = row.jumlah_satuan * row.harga_satuan;
                results.terpakai[row.sumber_dana] += anggaran;
            }
        });
        this.anggaranSumberdana = results;
    }

    validateForm(model): boolean {
        let result = false;

        if(this.activeSheet == 'kegiatan'){
            let requiredForm = ['kode_bidang', 'kode_kegiatan'];
            let aliases = { kode_bidang: 'Bidang', kode_kegiatan:'Kegiatan' }

            requiredForm.forEach(col => {
                if(model[col] == '' || !model[col]){
                    result = true;
                    if(aliases[col])
                        col = aliases[col];
                    this.toastr.error(`Kolom ${col} Tidak Boleh Kosong`);                    
                }
            })
            return result;
        }

        if (model.category == 'pendapatan' || model.category == 'pembiayaan') {
            let requiredForm = ['kelompok', 'jenis', 'obyek', 'uraian', 'satuan'];

            for (let i = 0; i < requiredForm.length; i++) {
                let col = requiredForm[i];

                if (model[col] == '' || !model[col]) {
                    result = true;
                    this.toastr.error(`Kolom ${col} Tidak Boleh Kosong!`,'')
                }                
            }
            if (!model.sumber_dana){
                result = true;
                this.toastr.error(`Kolom Sumberdana Tidak Boleh Kosong`,'')
            }
            return result;
        }

        if (model.category == 'belanja') {
            let requiredForm =['kode_bidang', 'kode_kegiatan', 'jenis', 'obyek','sumber_dana', 'uraian' ];
            let aliases = { kode_bidang: 'Bidang', kode_kegiatan: 'Kegiatan!' };

            for (let i = 0; i < requiredForm.length; i++) {
                let col = requiredForm[i];

                if (model[col] == '' || !model[col]) {
                    result = true;
                    if(aliases[col])
                        col = aliases[col];
                    this.toastr.error(`Kolom ${col} Tidak Boleh Kosong!`,'');
                }                
            }
            if (model.obyek.startsWith('5.1.3,') && !model.uraian_sub)
                result = true;
            if (!model.sumber_dana)
                result = true;
            if(model.uraian_rab_sub == '' && this.isObyekRABSub && model.is_add_rabsub){
                result = true;
                this.toastr.error(`Kolom Uraian Rab Sub Tidak Boleh Kosong!`,'');
            }
            if(!model.is_add_rabsub && this.isObyekRABSub){
                if(model.obyek_rab_sub && model.obyek_rab_sub != '')
                    return result;

                result = true;
                this.toastr.error(`Kolom Obyek Rab Sub Harus Dipilih!`,'');
            }
            return result;
        }

        if (model.tabActive == 'posting-apbdes') {
            let requiredForm = ['kode_posting', 'no_perdes', 'tanggal_posting'];
            let aliases = {kode_posting: 'Jenis Posting', tanggal_posting: 'Tanggal Posting'}

            for (let i = 0; i < requiredForm.length; i++) {
                let col = requiredForm[i];

                if (model[col] == '' || !model[col]) {
                    result = true;

                    if(aliases[col])
                        col = aliases[col];
                    this.toastr.error(`Kolom ${col} Tidak Boleh Kosong!`,'');
                }
            }
            return result;
        }
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

    keyupListener = (e) => {
        // ctrl+s
        if (e.ctrlKey && e.keyCode === 83) {
            this.pageSaver.onBeforeSave();
            e.preventDefault();
            e.stopPropagation();
        }
        // ctrl+p
        else if (e.ctrlKey && e.keyCode === 80) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    filterContent(){
        let hot = this.hots['rab'];
        let plugin = hot.getPlugin('hiddenColumns');
        let value = parseInt(String($('input[name=btn-filter]:checked').val()));
        let fields = schemas.rab.map(c => c.field);
        let result = PageSaver.spliceArray(fields, SHOW_COLUMNS[value]);

        (result.length == 5) ? result.push(10) 
            : ((result.length == 1) ? '' 
            : result.push(6));

        plugin.showColumns(this.resultBefore);
        plugin.hideColumns(result);

        hot.render();
        this.resultBefore = result;
    }
}
