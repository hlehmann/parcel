// @flow
const {SourceMapConsumer, SourceMapGenerator} = require('source-map');
const lineCounter = require('../../utils/src/lineCounter');

type mappingType = {
  generated: {
    line: number,
    column: number
  },
  original: null | {
    line: number,
    column: number
  },
  source: string | null,
  name: string | null
};

type RawSourceMapType = {
  version: number,
  sources: Array<string>,
  names: Array<string>,
  sourceRoot?: string,
  sourcesContent?: Array<string>,
  mappings: string,
  file: string
};

type RawMapInputType = SourceMapConsumer | string | RawSourceMapType;

type SourcesType = Object;

class SourceMap {
  // TODO: Write types for this
  mappings: Array<mappingType>;
  sources: SourcesType;
  lineCount: number;

  constructor(mappings?: Array<mappingType> = [], sources: SourcesType = {}) {
    this.mappings = this.purifyMappings(mappings);
    this.sources = sources;
    this.lineCount = 0;
  }

  // TODO: Would be nice to get rid of this
  purifyMappings(mappings: Array<mappingType>): Array<mappingType> {
    return mappings.filter((mapping: mappingType) => {
      if (!mapping || !mapping.generated) return false;

      let isValidOriginal =
        mapping.original === null ||
        (typeof mapping.original.line === 'number' &&
          mapping.original.line > 0 &&
          typeof mapping.original.column === 'number' &&
          mapping.source);

      let isValidGenerated =
        typeof mapping.generated.line === 'number' &&
        mapping.generated.line > 0 &&
        typeof mapping.generated.column === 'number';

      return isValidOriginal && isValidGenerated;
    });
  }

  async getConsumer(map: RawMapInputType) {
    if (map instanceof SourceMapConsumer) {
      return map;
    }

    let sourcemap: RawSourceMapType =
      typeof map === 'string' ? JSON.parse(map) : map;
    if (sourcemap.sourceRoot) delete sourcemap.sourceRoot;
    return new SourceMapConsumer(sourcemap);
  }

  async addMap(
    map: RawMapInputType | SourceMap,
    lineOffset: number = 0,
    columnOffset: number = 0
  ) {
    if (typeof map === 'string' || typeof map.mappings === 'string') {
      let consumer = await this.getConsumer(map);
      if (!consumer) return this;

      consumer.eachMapping(mapping => {
        this.addConsumerMapping(mapping, lineOffset, columnOffset);
        if (!this.sources[mapping.source]) {
          this.sources[mapping.source] = consumer.sourceContentFor(
            mapping.source,
            true
          );
        }
      });

      consumer.destroy();
    } else if (map.mappings && map.sources) {
      if (!map.eachMapping) {
        map = new SourceMap(map.mappings, map.sources);
      }

      // TODO: Get rid of this line... Flow Bug?
      if (!(map instanceof SourceMap)) {
        throw new Error('This should be impossible');
      }

      if (lineOffset === 0 && columnOffset === 0) {
        this.mappings = this.mappings.concat(map.mappings);
      } else {
        map.eachMapping(mapping => {
          this.addMapping(mapping, lineOffset, columnOffset);
        });
      }

      // TODO: Get rid of this line... Flow Bug?
      if (Array.isArray(map.sources)) {
        throw new Error('This should be impossible');
      }

      for (let sourceName of Object.keys(map.sources)) {
        if (!this.sources[sourceName]) {
          this.sources[sourceName] = map.sources[sourceName];
        }
      }
    } else {
      throw new Error('Could not merge sourcemaps, input is of unknown kind');
    }

    return this;
  }

  addMapping(mapping, lineOffset = 0, columnOffset = 0) {
    this.mappings.push({
      source: mapping.source,
      name: mapping.name,
      original: mapping.original,
      generated: {
        line: mapping.generated.line + lineOffset,
        column: mapping.generated.column + columnOffset
      }
    });
  }

  addConsumerMapping(mapping, lineOffset = 0, columnOffset = 0) {
    let original = null;
    if (
      typeof mapping.originalLine === 'number' &&
      mapping.originalLine > 0 &&
      typeof mapping.originalColumn === 'number'
    ) {
      original = {
        line: mapping.originalLine,
        column: mapping.originalColumn
      };
    }

    this.mappings.push({
      source: original ? mapping.source : null,
      name: mapping.name,
      original,
      generated: {
        line: mapping.generatedLine + lineOffset,
        column: mapping.generatedColumn + columnOffset
      }
    });
  }

  eachMapping(callback) {
    this.mappings.forEach(callback);
  }

  generateEmptyMap(sourceName, sourceContent) {
    this.sources[sourceName] = sourceContent;

    this.lineCount = lineCounter(sourceContent);
    for (let line = 1; line < this.lineCount + 1; line++) {
      this.addMapping({
        source: sourceName,
        original: {
          line: line,
          column: 0
        },
        generated: {
          line: line,
          column: 0
        }
      });
    }

    return this;
  }

  async extendSourceMap(original, extension) {
    if (!(extension instanceof SourceMap)) {
      extension = await new SourceMap().addMap(extension);
    }
    if (!(original instanceof SourceMap)) {
      original = await this.getConsumer(original);
    }

    extension.eachMapping(mapping => {
      let originalMapping = original.originalPositionFor({
        line: mapping.original.line,
        column: mapping.original.column
      });

      if (!originalMapping || !originalMapping.line) {
        return;
      }

      this.addMapping({
        source: originalMapping.source,
        name: originalMapping.name,
        original: {
          line: originalMapping.line,
          column: originalMapping.column
        },
        generated: {
          line: mapping.generated.line,
          column: mapping.generated.column
        }
      });

      if (!this.sources[originalMapping.source]) {
        this.sources[originalMapping.source] = original.sourceContentFor(
          originalMapping.source,
          true
        );
      }
    });

    original.destroy();

    return this;
  }

  findClosestGenerated(line, column) {
    if (line < 1) {
      throw new Error('Line numbers must be >= 1');
    }

    if (column < 0) {
      throw new Error('Column numbers must be >= 0');
    }

    if (this.mappings.length < 1) {
      return undefined;
    }

    let startIndex = 0;
    let stopIndex = this.mappings.length - 1;
    let middleIndex = (stopIndex + startIndex) >>> 1;

    while (
      startIndex < stopIndex &&
      this.mappings[middleIndex].generated.line !== line
    ) {
      let mid = this.mappings[middleIndex].generated.line;
      if (line < mid) {
        stopIndex = middleIndex - 1;
      } else if (line > mid) {
        startIndex = middleIndex + 1;
      }
      middleIndex = (stopIndex + startIndex) >>> 1;
    }

    let mapping = this.mappings[middleIndex];
    if (!mapping || mapping.generated.line !== line) {
      return this.mappings.length - 1;
    }

    while (
      middleIndex >= 1 &&
      this.mappings[middleIndex - 1].generated.line === line
    ) {
      middleIndex--;
    }

    while (
      middleIndex < this.mappings.length - 1 &&
      this.mappings[middleIndex + 1].generated.line === line &&
      column > this.mappings[middleIndex].generated.column
    ) {
      middleIndex++;
    }

    return middleIndex;
  }

  findClosest(line, column, key) {
    if (line < 1) {
      throw new Error('Line numbers must be >= 1');
    }

    if (column < 0) {
      throw new Error('Column numbers must be >= 0');
    }

    if (this.mappings.length < 1) {
      return undefined;
    }

    let startIndex = 0;
    let stopIndex = this.mappings.length - 1;
    let middleIndex = Math.floor((stopIndex + startIndex) / 2);

    while (
      startIndex < stopIndex &&
      this.mappings[middleIndex][key].line !== line
    ) {
      if (line < this.mappings[middleIndex][key].line) {
        stopIndex = middleIndex - 1;
      } else if (line > this.mappings[middleIndex][key].line) {
        startIndex = middleIndex + 1;
      }
      middleIndex = Math.floor((stopIndex + startIndex) / 2);
    }

    var mapping = this.mappings[middleIndex];
    if (!mapping || mapping[key].line !== line) {
      return this.mappings.length - 1;
    }

    while (
      middleIndex >= 1 &&
      this.mappings[middleIndex - 1][key].line === line
    ) {
      middleIndex--;
    }

    while (
      middleIndex < this.mappings.length - 1 &&
      this.mappings[middleIndex + 1][key].line === line &&
      column > this.mappings[middleIndex][key].column
    ) {
      middleIndex++;
    }

    return middleIndex;
  }

  originalPositionFor(generatedPosition) {
    let index = this.findClosestGenerated(
      generatedPosition.line,
      generatedPosition.column
    );

    let mapping = this.mappings[index];
    if (!mapping || !mapping.original) {
      return null;
    }

    return {
      source: mapping.source,
      name: mapping.name,
      line: mapping.original.line,
      column: mapping.original.column
    };
  }

  generatedPositionFor(originalPosition) {
    let index = this.findClosest(
      originalPosition.line,
      originalPosition.column,
      'original'
    );

    let mapping = this.mappings[index];
    return {
      source: mapping.source,
      name: mapping.name,
      line: mapping.generated.line,
      column: mapping.generated.column
    };
  }

  sourceContentFor(fileName: string) {
    return this.sources[fileName];
  }

  offset(lineOffset: number = 0, columnOffset: number = 0) {
    this.mappings.map(mapping => {
      mapping.generated.line = mapping.generated.line + lineOffset;
      mapping.generated.column = mapping.generated.column + columnOffset;
      return mapping;
    });

    this.lineCount += lineOffset;
  }

  stringify(file: string, sourceRoot: string) {
    let generator = new SourceMapGenerator({file, sourceRoot});

    this.eachMapping(mapping => generator.addMapping(mapping));
    Object.keys(this.sources).forEach(sourceName =>
      generator.setSourceContent(sourceName, this.sources[sourceName])
    );

    return generator.toString();
  }
}

module.exports = SourceMap;
