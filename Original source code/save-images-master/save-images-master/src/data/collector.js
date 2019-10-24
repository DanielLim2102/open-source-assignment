/* eslint no-var: 0 */
'use strict';

var collector = {
  active: true,
  cache: {}, // prevents duplicated inspection
  size: src => new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve({
      width: image.naturalWidth,
      height: image.naturalHeight
    });
    image.onerror = () => resolve({
      width: 0,
      height: 0
    });
    image.src = src;
  }),
  inspect: img => new Promise((resolve, reject) => {
    const next = ({type, size, disposition}) => {
      if (type && type.startsWith('text/html')) {
        reject(type);
      }
      // fix the type when possible
      if (img.src) {
        if (img.src.indexOf('.png?') !== -1 || img.src.endsWith('.png')) {
          type = 'image/png';
        }
        else if (
          img.src.indexOf('.jpg?') !== -1 ||
          img.src.indexOf('.jpeg?') !== -1 ||
          img.src.endsWith('.jpg') ||
          img.src.endsWith('.jpeg')
        ) {
          type = 'image/jpeg';
        }
        else if (img.src.indexOf('.bmp?') !== -1 || img.src.endsWith('.bmp')) {
          type = 'image/bmp';
        }
        else if (img.src.indexOf('.gif?') !== -1 || img.src.endsWith('.gif')) {
          type = 'image/gif';
        }
      }
      // forced the image file type for verified images
      if (!type && img.verified) {
        type = 'image/unknown';
      }
      if (type && type.startsWith('image/')) {
        Object.assign(img, {
          size: img.src.startsWith('http') ? (Number(size) || 0) : img.src.length,
          type,
          disposition: disposition || ''
        });
        if (img.src.startsWith('http')) {
          resolve(img);
        }
        // get image width and height for data-url images
        else {
          collector.size(img.src).then(obj => resolve(Object.assign(img, obj)));
        }
      }
      else {
        reject(type);
      }
    };
    chrome.runtime.sendMessage({
      cmd: 'xml-head',
      src: img.src
    }, next);
  }),
  loop: async regexps => {
    const cleanup = images => {
      const list = [];
      for (const img of images) {
        const {src} = img;
        if (src && (src.startsWith('http') || src.startsWith('ftp') || src.startsWith('data:'))) {
          if (collector.cache[src] === undefined) {
            collector.cache[src] = true;
            if (regexps && regexps.some(r => r.test(src)) === false) {
              continue;
            }
            list.push(img);
          }
        }
      }
      return list;
    };

    // get info for single link
    const analyze = img => {
      return collector.inspect(img).then(img => [img]).catch(type => {
        if (type && type.startsWith('text/html') && window.deep > 1) {
          return new Promise(resolve => {
            chrome.runtime.sendMessage({
              cmd: 'xml-img',
              src: img.src,
              extractLinks: window.deep === 3
            }, async images => {
              images = cleanup(images);
              // fix page link
              for (const i of images) {
                i.page = img.src;
              }
              if (images.length) {
                chrome.runtime.sendMessage({
                  cmd: 'links',
                  filters: regexps,
                  length: images.length
                });
                const tmp = [];
                for (let i = 0; collector.active && i < images.length; i += 5) {
                  const slice = images.slice(i, i + 5);
                  await Promise.all(slice.map(analyze)).then(images => tmp.push(...images));
                }
                resolve(collector.active ? [].concat([], ...tmp) : []);
              }
              else {
                resolve([]);
              }
            });
          });
        }
        else {
          return [];
        }
      });
    };
    // find images; part 1/1
    let images = [...document.images].map(img => ({
      width: img.width,
      height: img.height,
      src: img.src,
      verified: true, // this is an image even if content-type cannot be resolved,
      page: location.href
    }));
    // find images; part 1/2
    images.push(...[...document.querySelectorAll('source')].filter(i => i.srcset).map(i => ({
      src: i.srcset.split(' ')[0],
      page: location.href
    })));
    // find background images; part 2
    try {
      [...document.querySelectorAll('*')]
        .map(e => window.getComputedStyle(e).backgroundImage)
        .map(i => {
          const e = /url\(['"]([^)]+)["']\)/.exec(i);
          return e && e.length ? e[1] : null;
        }).forEach(src => {
          if (src.startsWith('//')) {
            src = document.location.protocol + src;
          }
          else if (src.startsWith('/')) {
            document.location.origin + src;
          }
          images.push({
            src,
            page: location.href
          });
        });
    }
    catch (e) {}
    // find linked images; part 3
    if (window.deep > 0) {
      [...document.querySelectorAll('a')].map(a => a.href)
        .forEach(src => images.push({
          src,
          page: location.href
        }));
    }
    // find hard-coded links; part 4
    if (window.deep > 0) {
      const r = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\\/%?=~_|!:,.;]*[-A-Z0-9+&@#\\/%=~_|])/gi;
      // decode html special characters; &amp;
      (document.documentElement.innerHTML.match(r) || [])
        .map(s => s.replace(/&amp;/g, '&'))
        .forEach(src => images.push({
          src,
          page: location.href
        }));
    }
    // clean
    images = cleanup(images);
    // notify the total number of links to be parsed
    chrome.runtime.sendMessage({
      cmd: 'links',
      filters: regexps,
      length: images.length
    });
    // loop
    for (let i = 0; collector.active && i < images.length; i += 5) {
      const slice = images.slice(i, i + 5);
      await Promise.all(slice.map(analyze))
        .then(images => collector.active && images.length && chrome.runtime.sendMessage({
          cmd: 'images',
          images: [].concat([], ...images),
          index: slice.length
        })).catch(e => console.log(e));
    }
  }
};
chrome.runtime.sendMessage({
  cmd: 'prefs'
}, prefs => {
  window.deep = prefs ? prefs.deep : 0;
  try {
    if (prefs && prefs.regexp) {
      if (typeof prefs.regexp === 'string') {
        return collector.loop([new RegExp(prefs.regexp)]);
      }
      else {
        return collector.loop(prefs.regexp.map(r => new RegExp(r)));
      }
    }
  }
  catch (e) {
    console.error(e);
  }
  collector.loop();
});
