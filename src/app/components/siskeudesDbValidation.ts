import { Component, NgZone } from '@angular/core';
import { Subscription } from 'rxjs';

import SiskeudesService from '../stores/siskeudesService';
import SettingsService from '../stores/settingsService';
import { Router, ActivatedRoute } from '@angular/router';

@Component({
    selector: 'siskeudes-db-validation',
    templateUrl: '../templates/siskeudesDbValidation.html',
    styles: [`
        :host {
            display: flex;
        }
    `],
})

export default class SiskeudesDbValidation {
    settingsSubscription: Subscription;
    routeSubscription: Subscription;
    siskeudesMessage: string;
    settings: any;
    page: string;

    constructor(
        private zone: NgZone,
        private siskeudesService: SiskeudesService,
        private settingsService: SettingsService,
        private router: Router,
        private activatedRoute: ActivatedRoute,
    ) {
    }

    ngOnInit(): void {
        this.routeSubscription =  this.activatedRoute.queryParams.subscribe( params => {
            let page = params['page'];
            this.navigate(page);
        });
    }

    async navigate(page){
        this.settingsSubscription = this.settingsService.getAll().subscribe(settings => {
            this.settings = settings;
            this.siskeudesMessage = this.siskeudesService.getSiskeudesMessage();

            if(this.siskeudesMessage || !page)
                return;
            
            this.router.navigate([`/${page}`])
        });      
    }

    ngOnDestroy(){
        this.routeSubscription.unsubscribe();
        this.settingsSubscription.unsubscribe();
    }
 
}