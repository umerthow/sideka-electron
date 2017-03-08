import { Component, Input } from "@angular/core";
import dataapi from '../stores/dataapi';
import schemas from '../schemas';
import { remote, shell } from 'electron'; // native electron module
import * as fs from 'fs';
import createPrintVars from '../helpers/printvars';

var $ = require('jquery');
var jetpack = require('fs-jetpack'); 
var Docxtemplater = require('docxtemplater');
var path = require('path');
var expressions = require('angular-expressions');
var ImageModule = require('docxtemplater-image-module');
var app = remote.app;

window['app'] = app;

@Component({
    selector: 'surat',
    inputs : ['hot'], 
    templateUrl: 'templates/surat.html'
})
export default class SuratComponent{
    letters: any[];
    result: any[];
    keyword: string;
    hot: any;
    selectedLetter: any;

    constructor(){   
        this.loadLetters();  
        this.selectedLetter = {"formData": {}};
        
    }
    
    loadLetters(): void {
        this.letters = [];

        this.letters.push({"name": 'kartu keluarga', "thumbnail": '../surat_thumbnails/kk.png', 
        "path": 'surat_templates/kk.docx', "form": null, "formData": {} });

        this.letters.push({"name": 'keterangan domisili', "thumbnail": '../surat_templates/ket_domisili.png', 
        "path": 'surat_templates/ket_domisili.docx', "form": 'domisili-form', "formData": {}});

        this.letters.push({"name": 'keterangan kelahiran', "thumbnail": '../surat_templates/ket_kelahiran.png', 
        "path": 'surat_templates/ket_kelahiran.docx', "form": null, "formData": {}  });

        this.letters.push({"name": 'keterangan umum', "thumbnail": '../surat_templates/ket_umum.png', 
        "path": 'surat_templates/ket_umum.docx', "form": null, "formData": {}  });

        this.letters.push({"name": 'pindah datang wni', "thumbnail": '../surat_templates/pindah_datang_wni.png', 
        "path": 'surat_templates/pindah_datang_wni.docx', "form": null, "formData": {}  });

        this.letters.push({"name": 'pelaporan kematian', "thumbnail": '../surat_thumbnails/kk.png', 
        "path": 'surat_templates/pelaporan-kematian.docx', "form": null, "formData": {}  });

        this.letters.push({"name": 'pindah kelamin', "thumbnail": '../surat_thumbnails/kk.png', 
        "path": 'surat_templates/pelaporan-kematian.docx', "form": null, "formData": {}  });

        this.letters.push({"name": 'pindah agama', "thumbnail": '../surat_thumbnails/kk.png', 
        "path": 'surat_templates/pelaporan-kematian.docx', "form": null, "formData": {} });

        this.letters.push({"name": 'pindah keluarga', "thumbnail": '../surat_thumbnails/kk.png', 
        "path": 'surat_templates/pelaporan-kematian.docx', "form": null, "formData": {}  });

        this.letters.push({"name": 'pindah pasangan', "thumbnail": '../surat_thumbnails/kk.png', 
        "path": 'surat_templates/pelaporan-kematian.docx', "form": null, "formData": {}  });

        this.result = this.letters;
    }

    search(): void {
        if(!this.keyword || this.keyword === '')
            this.result = this.letters;

        this.result = this.letters.filter(e => e.name.indexOf(this.keyword) > -1);
    }

    convertDataURIToBinary(base64): any{
        const string_base64 = base64.replace(/^data:image\/(png|jpg);base64,/, "");
        var binary_string = new Buffer(string_base64, 'base64').toString('binary');
        
        var len = binary_string.length;
        var bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) {
            var ascii = binary_string.charCodeAt(i);
            bytes[i] = ascii;
        }
        return bytes.buffer;
    }

    print(letter: any): boolean {
        this.selectedLetter = letter;

        if(letter.form)
            $('#' + letter.form).modal('show');
        else
            this.doPrint();

        console.log(this.hot.getSourceData());
        return false;
    }

    doPrint(): void{
        switch(this.selectedLetter.name){
            case 'keterangan umum':
              this.printKeteranganUmum(this.selectedLetter);
            break;
            case 'kartu keluarga':
              this.printKK(this.selectedLetter);
            break;
            case 'keterangan domisili':
              this.printKeteranganDomisili(this.selectedLetter);
            break;
        }
    }

    printKeteranganUmum(data: any): void {
        var letter = data;
        var selected = this.hot.getSelected();

        if(!selected)
            return;

        var fileName = remote.dialog.showSaveDialog({
            filters: [
                {name: 'Word document', extensions: ['docx']},
            ]
        });

        if(fileName)
          this.renderDocument(selected, letter, fileName);
    }

    printKK(data: any): void {
        
    }

    printKeteranganDomisili(data: any): void {
        var letter = data;
        var selected = this.hot.getSelected();

        $('#' + data.form).modal('hide');

         if(!selected)
            return;

        var fileName = remote.dialog.showSaveDialog({
            filters: [
                {name: 'Word document', extensions: ['docx']},
            ]
        });

        var dataSource: any[] = this.hot.getSourceData();
        var penduduk: any = this.hot.getSelected();

        var keluarga = dataSource.filter(e => e['21'] === penduduk['21']);

        console.log(keluarga);
        
        if(fileName)
            this.renderDocument(selected, letter, fileName);
    }

    renderDocument(selected: any, letter: any, fileName: string): void {
        if(!fileName.endsWith(".docx"))
            fileName = fileName+".docx";

        var angularParser= function(tag){
            var expr=expressions.compile(tag);
            return {get:expr};
        }

        var nullGetter = function(tag, props) {
            return "";
        };
        
        var penduduk = schemas.arrayToObj(this.hot.getDataAtRow(selected[0]), schemas.penduduk);
        var content = fs.readFileSync(letter.path, "binary");

        let dataFile = path.join(app.getPath("userData"), "setting.json");

        if(!jetpack.exists(dataFile))
            return null;

        let data = JSON.parse(jetpack.read(dataFile));
        let that = this;
        
        dataapi.getDesa(function(desas){
            var auth = dataapi.getActiveAuth();
            var desa = desas.filter(d => d.blog_id == auth['desa_id'])[0];
            var printvars = createPrintVars(desa);

            let opts = { 
                "centered": false, 
                "getImage": (tagValue) => {
                    return tagValue;
                }, 
                "getSize": (image, tagValue, tagName) => {
                    return [100, 100];
                } 
            };

            letter.penduduk = penduduk;
            letter.vars = printvars;
            
            var imageModule = new ImageModule(opts);   
            var doc = new Docxtemplater(content);

            doc.setOptions({parser:angularParser, nullGetter: nullGetter});
            doc.setData({penduduk:  letter.penduduk, vars: letter.vars, form: letter.formData, image: that.convertDataURIToBinary(data.logo)});
            doc.render();

            var buf = doc.getZip().generate({type:"nodebuffer"});
            fs.writeFileSync(fileName, buf);
            shell.openItem(fileName);
            app.relaunch();
        });
    }
}