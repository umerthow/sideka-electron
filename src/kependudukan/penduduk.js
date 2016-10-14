import path from 'path';
import fs from 'fs';
import $ from 'jquery';
import { remote, app, shell } from 'electron'; // native electron module
import jetpack from 'fs-jetpack'; // module loaded from npm
import Docxtemplater from 'docxtemplater';
var Handsontable = require('./handsontablep/dist/handsontable.full.js');
import { importPenduduk } from '../helpers/importer';
import dataapi from '../dataapi/dataapi';
import schemas from '../schemas';
import { initializeTableSearch, initializeTableCount, initializeTableSelected } from '../helpers/table';

var app = remote.app;
var hot;
var sheetContainer;
var emptyContainer;

document.addEventListener('DOMContentLoaded', function () {
    $("title").html("Data Penduduk - " +dataapi.getActiveAuth().desa_name);

    sheetContainer = document.getElementById('sheet');
    emptyContainer = document.getElementById('empty');
    window.hot = hot = new Handsontable(sheetContainer, {
        data: [],
        topOverlay: 34,

        rowHeaders: true,
        colHeaders: schemas.getHeader(schemas.penduduk),
        columns: schemas.penduduk,

        colWidths: schemas.getColWidths(schemas.penduduk),
        rowHeights: 23,
        
        columnSorting: true,
        sortIndicator: true,
        
        renderAllRows: false,
        outsideClickDeselects: false,
        autoColumnSize: false,
        search: true,
        filters: true,
        contextMenu: ['row_above', 'remove_row'],
        dropdownMenu: ['filter_by_condition', 'filter_action_bar'],
    });
    
    var formSearch = document.getElementById("form-search");
    var inputSearch = document.getElementById("input-search");
    initializeTableSearch(hot, document, formSearch, inputSearch);
    
    var spanSelected = $("#span-selected")[0];
    initializeTableSelected(hot, 1, spanSelected);
    
    var spanCount = $("#span-count")[0];
    initializeTableCount(hot, spanCount);

    window.addEventListener('resize', function(e){
        hot.render();
    })
 
    var importExcel = function(){
        var files = remote.dialog.showOpenDialog();
        if(files && files.length){
            var objData = importPenduduk(files[0]);
            var data = objData.map(o => schemas.objToArray(o, schemas.penduduk));

            hot.loadData(data);
            $(emptyContainer).addClass("hidden");
            $(sheetContainer).removeClass("hidden");
            setTimeout(function(){
                hot.render();
            },500);
        }
    }
    document.getElementById('btn-open').onclick = importExcel;
    document.getElementById('btn-open-empty').onclick = importExcel;

    document.getElementById('btn-save').onclick = function(){
        var timestamp = new Date().getTime();
        var content = {
            timestamp: timestamp,
            data: hot.getSourceData()
        };
        dataapi.saveContent("penduduk", content);
    };

    document.getElementById('btn-print').onclick = function(){
        var selected = hot.getSelected();
        if(!selected)
            return;
        var fileName = remote.dialog.showSaveDialog({
            filters: [
                {name: 'Word document', extensions: ['docx']},
            ]
        });
        if(fileName){
            if(!fileName.endsWith(".docx"))
                fileName = fileName+".docx";
            var penduduk = schemas.arrayToObj(hot.getDataAtRow(selected[0]), schemas.penduduk);
            var content = fs.readFileSync(path.join(app.getAppPath(), "templates","surat.docx"),"binary");
            var doc=new Docxtemplater(content);
            doc.setData(penduduk);
            doc.render();

            var buf = doc.getZip().generate({type:"nodebuffer"});
            fs.writeFileSync(fileName, buf);
            shell.openItem(fileName);
        }
    };
    
    dataapi.getContent("penduduk", {data: []}, function(content){
        var initialData = content.data;
        hot.loadData(initialData);
        //hot.loadData(initialData.concat(initialData).concat(initialData).concat(initialData));
        if(initialData.length == 0)
        {
            $(emptyContainer).removeClass("hidden");
        }
        else 
        {
            $(sheetContainer).removeClass("hidden");
        }
        setTimeout(function(){
            hot.render();
        },500);
    })
    
    
});