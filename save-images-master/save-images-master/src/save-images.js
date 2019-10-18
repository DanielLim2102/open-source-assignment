/* Copyright (C) 2014-2017 Joe Ertaba
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.

 * Home: http://add0n.com/save-images.html
 * GitHub: https://github.com/belaviyo/save-images/ */

/* globals JSZip, onClicked, notify */
'use strict';

window.count = 0;

function timeout() {
  return Number(localStorage.getItem('timeout') || 10) * 1000;
}

const downloads = {};

function Download() {
  this.zip = new JSZip();
  this.indices = {};
  this.abort = false;
}
Download.prototype.init = function(request, tab) {
  this.request = request;
  this.tab = tab;
  this.jobs = request.images;
  this.length = this.jobs.length;

  this.one();
};
Download.prototype.terminate = function() {
  if (this.abort === false) {
    notify(`Image downloading is canceled for "${this.tab.title}".
Do not close the panel if you want to keep downloading`);
  }
  if (chrome.browserAction.setBadgeText) {
    chrome.browserAction.setBadgeText({
      tabId: this.tab.id,
      text: ''
    });
  }
  this.abort = true;
  this.jobs = [];
};
Download.prototype.one = function() {
  if (this.abort) {
    return;
  }
  const {id} = this.tab;
  const jobs = this.jobs;
  const request = this.request;

  if (chrome.browserAction.setBadgeText) {
    chrome.browserAction.setBadgeText({
      tabId: id,
      text: jobs.length ? String(jobs.length) : ''
    });
  }
  chrome.tabs.sendMessage(id, {
    cmd: 'progress',
    value: jobs.length
  });
  const [j1, j2, j3, j4, j5] = [jobs.shift(), jobs.shift(), jobs.shift(), jobs.shift(), jobs.shift()];
  if (j1) {
    Promise.all([
      j1 ? this.download(j1).catch(() => {}) : Promise.resolve(),
      j2 ? this.download(j2).catch(() => {}) : Promise.resolve(),
      j3 ? this.download(j3).catch(() => {}) : Promise.resolve(),
      j4 ? this.download(j4).catch(() => {}) : Promise.resolve(),
      j5 ? this.download(j5).catch(() => {}) : Promise.resolve()
    ]).then(() => this.one());
  }
  else {
    if (request.zip) {
      this.zip.generateAsync({type: 'blob'})
        .then(content => {
          const url = URL.createObjectURL(content);
          chrome.downloads.download({
            url,
            filename: request.filename,
            conflictAction: 'uniquify',
            saveAs: request.saveAs
          }, () => {
            chrome.tabs.sendMessage(id, {
              cmd: 'close-me'
            });
            delete downloads[id];
            window.setTimeout(() => URL.revokeObjectURL(url), 10000);
          });
        });
    }
    else {
      chrome.tabs.sendMessage(id, {
        cmd: 'close-me'
      });
      delete downloads[id];
    }
  }
};
Download.prototype.download = function(obj) {
  const {filename, zip} = this.request;
  if (zip) {
    return new Promise((resolve, reject) => {
      if (this.abort) {
        return;
      }

      const req = new XMLHttpRequest(); // do not use fetch API as it cannot get CORS headers
      req.open('GET', obj.src);
      console.log(obj);
      if (obj.size) {
        // for huge files, we need to alter the timeout
        req.timeout = Math.max(timeout(), timeout() * obj.size / (100 * 1024));
      }
      req.onerror = req.ontimeout = reject;
      req.responseType = 'blob';
      req.onload = () => {
        this.zip.file(obj.filename, req.response);
        resolve();
      };
      req.send();
    });
  }
  else {
    return new Promise(resolve => {
      const path = filename.split('/');
      path.pop();
      path.push(obj.filename);

      chrome.downloads.download({
        url: obj.src,
        filename: path.join('/'),
        conflictAction: 'uniquify',
        saveAs: false
      }, () => {
        window.setTimeout(resolve, 3000);
      });
    });
  }
};

const cache = {};
chrome.tabs.onRemoved.addListener(tabId => delete cache[tabId]);

chrome.runtime.onMessage.addListener((request, sender, response) => {
  if (request.cmd === 'get-images') {
    response({
      domain: new URL(sender.tab.url).hostname,
      title: sender.tab.title
    });
    let regexp = '';
    chrome.storage.local.get({
      'json': {}
    }, prefs => {
      for (const r of Object.keys(prefs.json)) {
        try {
          if ((new RegExp(r)).test(sender.tab.url)) {
            regexp = prefs.json[r];
            break;
          }
        }
        catch (e) {}
      }
      cache[sender.tab.id] = {
        deep: request.deep,
        regexp
      };
      chrome.tabs.executeScript(sender.tab.id, {
        file: '/data/collector.js',
        runAt: 'document_start',
        allFrames: true,
        matchAboutBlank: true
      }, () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          notify(lastError.message);
        }
      });
    });
  }
  else if (request.cmd === 'prefs') {
    response(cache[sender.tab.id]);
  }
  else if (request.cmd === 'images' || request.cmd === 'links') {
    chrome.tabs.sendMessage(sender.tab.id, request);
  }
  else if (request.cmd === 'save-images') {
    notify('Saving ' + request.images.length + ' images');

    if (downloads[sender.tab.id]) {
      downloads[sender.tab.id].terminate();
    }
    downloads[sender.tab.id] = new Download();
    downloads[sender.tab.id].init(request, sender.tab);
  }
  else if (request.cmd === 'xml-head') {
    // use GET; HEAD is not widely supported
    const req = new XMLHttpRequest();
    req.open('GET', request.src);
    req.timeout = timeout();
    req.ontimeout = req.onerror = () => response({});
    chrome.tabs.sendMessage(sender.tab.id, {
      cmd: 'header-resolved'
    });
    req.onreadystatechange = () => {
      if (req.readyState === req.HEADERS_RECEIVED) {
        response({
          type: req.getResponseHeader('content-type') || '',
          size: req.getResponseHeader('content-length'),
          disposition: req.getResponseHeader('content-disposition')
        });
        req.abort();
      }
    };
    req.send();
    return true;
  }
  else if (request.cmd === 'xml-img') {
    const req = new XMLHttpRequest();
    req.open('GET', request.src);
    req.responseType = 'document';
    req.timeout = timeout();
    req.onload = () => {
      const images = [];
      images.push(...[...req.response.images]
        .map(img => ({
          width: img.width,
          height: img.height,
          src: img.src,
          verified: true
        })));
      if (request.extractLinks) {
        images.push(...[...req.response.querySelectorAll('a')].map(a => a.href)
          .filter(s => s && (s.startsWith('http') || s.startsWith('ftp') || s.startsWith('data:')))
          .map(src => ({src})));
      }

      response(images);
    };
    req.ontimeout = req.onerror = () => response([]);
    req.send();
    return true;
  }
  //
  if (request.cmd === 'stop' || request.cmd === 'close-me' || request.cmd === 'reload-me') {
    if (request.cmd !== 'save-images') {
      // stop downloading
      const download = downloads[sender.tab.id];
      if (download) {
        download.terminate();
      }
    }
    // stop image collection
    chrome.tabs.executeScript(sender.tab.id, {
      code: `
        if (typeof collector === 'object') {
          collector.active = false;
        }
      `
    });
  }
  //
  if (request.cmd === 'close-me') {
    chrome.tabs.sendMessage(sender.tab.id, {
      cmd: 'close-me'
    });
  }
  if (request.cmd === 'reload-me') {
    onClicked(sender.tab);
  }
});
