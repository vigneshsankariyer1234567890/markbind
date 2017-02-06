'use strict';

const htmlparser = require('htmlparser2');
const md = require('markdown-it')({
  html: true,
  linkify: true
});

// markdown-it plugins
md.use(require('markdown-it-mark'))
  .use(require('markdown-it-emoji'))
  .use(require('markdown-it-ins'));

// fix table style
md.renderer.rules.table_open = (tokens, idx) => {
  return '<table class="table">';
};

const _ = require('lodash');
const Promise = require('bluebird');

const cheerio = require('cheerio');
cheerio.prototype.options.xmlMode = true; // Enable xml mode for self-closing tag
cheerio.prototype.options.decodeEntities = false; // Don't escape HTML entities

const utils = require('./utils');

const fs = require('fs');
const path = require('path');
const url = require('url');

/*
 * Utils
 */
function isText(element) {
  return element.type === 'text';
}

function Parser(options) {
  this._options = options || {};
  this._fileCache = {};
  this.dynamicIncludeSrc = [];
}

Parser.prototype.getDynamicIncludeSrc = function() {
  return _.clone(this.dynamicIncludeSrc);
};

Parser.prototype._preprocess = function (element, context) {
  let self = this;
  if (element.name === 'include') {
    let isInline = _.hasIn(element.attribs, 'inline');
    let isDynamic = _.hasIn(element.attribs, 'dynamic');
    let isUrl = utils.isUrl(element.attribs.src);
    let includeSrc = url.parse(element.attribs.src);
    let includeSrcPath = includeSrc.path;
    let filePath = isUrl ? element.attribs.src : path.resolve(path.dirname(context.cwf), includeSrcPath);
    element.name = isInline ? 'span' : 'div';

    if (isDynamic) {
      element.name = 'dynamic-panel';
      element.attribs.src = filePath;
      delete element.attribs.dynamic;
      return element;
    }

    if (isUrl) {
      return element; // only keep url path for dynamic
    }

    let isIncludeSrcMd = utils.getExtName(filePath) === 'md';
    self._fileCache[filePath] = self._fileCache[filePath] ?
      self._fileCache[filePath] : fs.readFileSync(filePath, 'utf8');

    if (isIncludeSrcMd && context.source === 'html') {
      // HTML include markdown, use special tag to indicate markdown code.
      element.name = 'markdown';
    }

    let fileContent = self._fileCache[filePath]; // cache the file contents to save some I/O
    delete element.attribs.src;
    delete element.attribs.inline;

    if (includeSrc.hash) {
      // directly get segment from the src
      let segmentSrc = cheerio.parseHTML(fileContent);
      let $ = cheerio.load(segmentSrc);
      let htmlContent = $(includeSrc.hash).html();
      let actualContent = context.mode === 'include' ?
        (isInline ? utils.wrapContent(htmlContent) : utils.wrapContent(htmlContent, '\n\n', '\n'))
        : md.render(htmlContent);
      if (!isIncludeSrcMd) {
        // Include HTML. Just let it be.
        actualContent = htmlContent;
      }
      element.children = cheerio.parseHTML(actualContent); // the needed content;
    } else {
      let actualContent = context.mode === 'include' ?
        (isInline ? utils.wrapContent(fileContent) : utils.wrapContent(fileContent, '\n\n', '\n'))
        : md.render(fileContent);
      if (!isIncludeSrcMd) {
        // Include HTML. Just let it be.
        actualContent = fileContent;
      }
      element.children = cheerio.parseHTML(actualContent);
    }

    // The element's children are in the new context
    // Process with new context
    let childContext = _.cloneDeep(context);
    childContext.cwf = filePath;
    childContext.source = isIncludeSrcMd ? 'md' : 'html';
    if (element.children && element.children.length > 0) {
      element.children = element.children.map((e) => {
        return self._preprocess(e, childContext);
      });
    }
  } else {
    if (element.children && element.children.length > 0) {
      element.children = element.children.map((e) => {
        return self._preprocess(e, context);
      });
    }
  }

  return element;
};

Parser.prototype._parse = function (element, context) {
  let self = this;
  if (_.isArray(element)) {
    return element.map((el) => {
      return self._parse(el, context);
    });
  }

  if (isText(element)) {
    return element;
  } else {
    if (element.name) {
      element.name = element.name.toLowerCase();
    }

    switch (element.name) {
    case 'markdown':
      element.name = 'div';
      cheerio.prototype.options.xmlMode = false;
      element.children = cheerio.parseHTML(md.render(cheerio.html(element.children)));
      cheerio.prototype.options.xmlMode = true;
      break;
    case 'dynamic-panel':
      let hasIsOpen = _.hasIn(element.attribs, 'isOpen');
      element.attribs.isOpen = hasIsOpen ? hasIsOpen : false;
      element.attribs.header = element.attribs.name || '';
      this.dynamicIncludeSrc.push(element.attribs.src);
      try {
        if (fs.statSync(element.attribs.src).isFile()) {
          element.attribs.src = utils.setExtension(path.basename(element.attribs.src), '._include_.html');
        }
      } catch(e) {
        // Pass: src is not on filesystem (invalid or remote)
      }
      break;
    }

    if (element.children) {
      element.children.forEach(child => {
        self._parse(child, context);
      });
    }

    return element;
  }
};

Parser.prototype._trimNodes = function (node) {
  let self = this;
  if (node.children) {
    for (let n = 0; n < node.children.length; n++) {
      let child = node.children[n];
      if (
        child.type === 'comment' ||
        (child.type === 'text' && !/\S/.test(child.data))
      ) {
        node.children.splice(n, 1);
        n--;
      } else if (child.type === 'tag') {
        self._trimNodes(child);
      }
    }
  }
};

Parser.prototype.includeFile = function (file, cb) {
  cb = cb || function () {}; // create empty callback

  let context = {};
  context.cwf = file; // current working file
  context.mode = 'include';

  return new Promise((resolve, reject) => {
    let handler = new htmlparser.DomHandler((error, dom) => {
      if (error) {
        reject(error);
        cb(error);
        return;
      }
      let nodes = dom.map(d => {
        return this._preprocess(d, context);
      });
      resolve(cheerio.html(nodes));
      cb(null, cheerio.html(nodes));
    });

    let parser = new htmlparser.Parser(handler, {
      xmlMode: true,
      decodeEntities: true
    });

    // Read files
    fs.readFile(file, (err, data) => {
      if (err) {
        reject(err);
        cb(err);
        return;
      }
      let fileExt = utils.getExtName(file);
      if (fileExt === 'md') {
        context.source = 'md';
        parser.parseComplete(data.toString());
      } else if (fileExt === 'html') {
        context.source = 'html';
        parser.parseComplete(data);
      } else {
        let err = new Error(`Unsupported File Extension: '${fileExt}'`);
        cb(err);
        reject(err);
      }
    });
  });
};

Parser.prototype.renderFile = function (file, cb) {
  cb = cb || function () {}; // create empty callback

  let context = {};
  context.cwf = file; // current working file
  context.mode = 'render';

  return new Promise((resolve, reject) => {
    let handler = new htmlparser.DomHandler((error, dom) => {
      if (error) {
        reject(error);
        cb(error);
        return;
      }
      let nodes = dom.map(d => {
        return this._parse(d, context);
      });
      nodes.forEach(d => {
        this._trimNodes(d);
      });
      cheerio.prototype.options.xmlMode = false;
      resolve(cheerio.html(nodes));
      cb(null, cheerio.html(nodes));
      cheerio.prototype.options.xmlMode = true;
    });

    let parser = new htmlparser.Parser(handler, {
      xmlMode: true,
      decodeEntities: true
    });

    // Read files
    fs.readFile(file, (err, data) => {
      if (err) {
        reject(err);
        cb(err);
        return;
      }
      let inputData = data;
      let fileExt = utils.getExtName(file);
      if (fileExt === 'md') {
        inputData = md.render(inputData.toString());
        context.source = 'md';
        parser.parseComplete(inputData);
      } else if (fileExt === 'html') {
        context.source = 'html';
        parser.parseComplete(data);
      } else {
        let err = new Error(`Unsupported File Extension: '${fileExt}'`);
        cb(err);
        reject(err);
      }
    });
  });
};

module.exports = Parser;