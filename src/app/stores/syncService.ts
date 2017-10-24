import { remote } from 'electron';
import { Injectable, ViewContainerRef } from '@angular/core';
import { ReplaySubject } from 'rxjs';

import * as path from 'path';
const cron = require('node-cron');

import schemas from '../schemas';
import DataApiService from '../stores/dataApiService';
import SiskeudesService from '../stores/siskeudesService';
import SettingsService from '../stores/settingsService';
import SiskeudesReferenceHolder from '../stores/siskeudesReferenceHolder';
import {ContentManager, PerencanaanContentManager, PenganggaranContentManager, SppContentManager, PenerimaanContentManager} from '../stores/siskeudesContentManager';
import SharedService from '../stores/sharedService';
import PageSaver from '../helpers/pageSaver';
import { fromSiskeudes } from '../stores/siskeudesFieldTransformer';
import { ToastsManager, Toast } from 'ng2-toastr';
import { DiffTracker } from '../helpers/diffs';
import { Router, ActivatedRoute } from '@angular/router';
import { LocationStrategy } from '@angular/common';


@Injectable()
export default class SyncService {

    private _syncSiskeudesJob: any;
    private _syncMessage: string;
    private _toast: Toast;
    private _vcr: ViewContainerRef;

    constructor(
        private _dataApiService: DataApiService,
        private _siskeudesService: SiskeudesService,
        private _settingsService: SettingsService,
        private _sharedService: SharedService,
        private _toastr: ToastsManager,
        private _router: Router,
    ) { 
    }

    public setViewContainerRef(vcr: ViewContainerRef){
        this._vcr = vcr;
    }

    async syncPenduduk(): Promise<void> {
        let bundleSchemas = { "penduduk": schemas.penduduk, 
                      "mutasi": schemas.mutasi, 
                      "log_surat": schemas.logSurat, 
                      "prodeskel": schemas.prodeskel 
                    };
        await this.syncContent("penduduk", null, bundleSchemas);
    }

    async syncPerencanaan(): Promise<void> {
        let desa = await this.getDesa();
        let bundleSchemas = { renstra: schemas.renstra, rpjm: schemas.rpjm, 
            rkp1: schemas.rkp, 
            rkp2: schemas.rkp, 
            rkp3: schemas.rkp, 
            rkp4: schemas.rkp, 
            rkp5: schemas.rkp, 
            rkp6: schemas.rkp, 
        };
        let dataReferences = new SiskeudesReferenceHolder(this._siskeudesService);
        let contentManager = new PerencanaanContentManager(this._siskeudesService, desa, null);
        await this.syncSiskeudes('perencanaan', desa, contentManager, bundleSchemas);
    }

    async syncPenerimaan(): Promise<void> {
        let desa = await this.getDesa();
        let bundleSchemas = { tbp: schemas.tbp, tbp_rinci: schemas.tbp_rinci};
        let dataReferences = new SiskeudesReferenceHolder(this._siskeudesService);
        let contentManager = new PenerimaanContentManager(this._siskeudesService, desa, null);
        await this.syncSiskeudes('penerimaan', desa, contentManager, bundleSchemas);
    }

    async syncPenganggaran(): Promise<void> {
        let desa = await this.getDesa();
        let bundleSchemas = { kegiatan: schemas.kegiatan, rab: schemas.rab }
        let dataReferences = new SiskeudesReferenceHolder(this._siskeudesService);
        let contentManager = new PenganggaranContentManager(this._siskeudesService, desa, null, null);
        await this.syncSiskeudes('penganggaran', desa, contentManager, bundleSchemas);
    }

    async syncSpp(): Promise<void> {
        let desa = await this.getDesa();
        let bundleSchemas = { spp: schemas.spp, spp_rinci: schemas.spp_rinci, spp_bukti: schemas.spp_bukti };
        let dataReferences = new SiskeudesReferenceHolder(this._siskeudesService);
        let contentManager = new SppContentManager(this._siskeudesService, desa, dataReferences);
        await this.syncSiskeudes('spp', desa, contentManager, bundleSchemas);
    }

    private async getDesa(): Promise<any>{
        let settings =  this._settingsService.get("kodeDesa");
        let desas = await this._siskeudesService.getTaDesa(settings.kodeDesa);
        return desas[0];
    }

    private async syncContent(contentType, contentSubType, bundleSchemas){
        if(contentType == this.getCurrentUrl()){
            console.log("Skipping. Page is active", contentType);
            return;
        }

        let localContent = this._dataApiService.getLocalContent(bundleSchemas, contentType, contentSubType);
        let numOfDiffs = DiffTracker.getNumOfDiffs(localContent);
        if(numOfDiffs == 0){
            console.log("Skipping. Already synchronized: ", contentType, contentSubType, localContent);
            return;
        }
    }

    private async syncSiskeudes(contentType, desa, contentManager, bundleSchemas){
        if(contentType == this.getCurrentUrl()){
            console.log("Skipping. Page is active", contentType);
            return;
        }

        let contentSubType = desa.tahun;
        let localContent = this._dataApiService.getLocalContent({}, contentType, contentSubType);
        if(localContent.isServerSynchronized){
            console.log("Skipping. Already synchronized: ", contentType, desa, localContent);
            return;
        }

        try {
            this.syncMessage = "Mengirim data "+contentType;
            let dataReferences = new SiskeudesReferenceHolder(this._siskeudesService);
            let contents = await contentManager.getContents();
            let bundle = {data: contents, rewriteData: true, changeId: 0};
            
            console.log("Will synchronize: ", contentType, desa, bundle);
            await this._dataApiService.saveContent(contentType, contentSubType, bundle, bundleSchemas, null).toPromise();

            /*
            localContent.isServerSynchronized = true;
            let localContentFilename = this._sharedService.getContentFile(contentType, contentSubType);
            this._dataApiService.writeFile(localContent, localContentFilename);
            */
        } finally {
            this.syncMessage = null;
        }
    }

    private getCurrentUrl(){
        let urlTree = this._router.parseUrl(this._router.url);
        return urlTree.root.children['primary'].segments.map(it => it.path).join('/');
    }

    async syncAll(): Promise<void> {
        await this.syncPerencanaan();
        await this.syncPenganggaran();
        await this.syncSpp();
        await this.syncPenerimaan();
    }

    startSync(){
        if(this._syncSiskeudesJob)
            return;    
        this._syncSiskeudesJob = cron.schedule("*/1 * * * *", () => {
            this.syncAll();
        });
    }

    stopSync(): void {       
        if (this._syncSiskeudesJob){
            this._syncSiskeudesJob.destroy();
            this._syncSiskeudesJob = null;
        }
    }

    get syncMessage(): string{
        return this._syncMessage;
    }

    set syncMessage(value: string){
        this._syncMessage = value;

        if(!this._vcr)
            return;
        this._toastr.setRootViewContainerRef(this._vcr);

        if(this._toast){
            this._toastr.dismissToast(this._toast);
            this._toast = null;
        }
        if(value){
            this._toastr.info(value, "Sinkronisasi", {dismiss: 'controlled'}).then( toast => {
                this._toast = toast;
            });
        }
    }
    
}
