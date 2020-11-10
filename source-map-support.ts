import { SourceMapConsumer, MappedPosition } from 'source-map'
import path from 'path'
import fs from 'fs'
import Module from 'module'
// @ts-expect-error
import CallSiteToString from './CallSiteToString'

interface SourceMap {
  url: string
  map: SourceMapConsumer
}

interface SourceMapRaw {
  url: string
  map: string
}

interface Options {
  emptyCacheBetweenOperations?: boolean
  handleUncaughtExceptions?: boolean
  hookRequire?: boolean
}

// Only install once if called multiple times
var errorFormatterInstalled = false
var uncaughtShimInstalled = false
var hookRequireInstalled = false

// If true, the caches are reset before a stack trace formatting operation
var emptyCacheBetweenOperations = false

// Maps a file path to a string containing the file contents
let fileContentsCache: { [key: string]: string | null } = {}

// Maps a file path to a source map for that file
let sourceMapCache: { [key: string]: SourceMap | null } = {}

// Regex for detecting source maps
const reSourceMap = /^data:application\/json[^,]+base64,/

function retrieveFile (path: string): string | null {
  // Trim the path to make sure there is no extra whitespace.
  path = path.trim()
  if (/^file:/.test(path)) {
    // existsSync/readFileSync can't handle file protocol, but once stripped, it works
    path = path.replace(/file:\/\/\/(\w:)?/, function (protocol, drive: boolean) {
      return drive
        ? '' // file:///C:/dir/file -> C:/dir/file
        : '/' // file:///root-dir/file -> /root-dir/file
    })
  }
  if (path in fileContentsCache) {
    return fileContentsCache[path]
  }

  let contents = ''
  try {
    contents = fs.readFileSync(path, 'utf8')
  } catch (er) {
    /* ignore any errors */
  }

  fileContentsCache[path] = contents
  return contents
}

// Support URLs relative to a directory, but be careful about a protocol prefix
// in case we are in the browser (i.e. directories may start with "http://" or "file:///")
function supportRelativeURL (file: string | null, url: string): string {
  if (file === null) return url
  var dir = path.dirname(file)
  var match = /^\w+:\/\/[^/]*/.exec(dir)
  var protocol = match !== null ? match[0] : ''
  var startPath = dir.slice(protocol.length)
  if (protocol !== '' && /^\/\w:/.test(startPath)) {
    // handle file:///C:/ paths
    protocol += '/'
    return protocol + path.resolve(dir.slice(protocol.length), url).replace(/\\/g, '/')
  }
  return protocol + path.resolve(dir.slice(protocol.length), url)
}

function retrieveSourceMapURL(source: string): string | null {
  // Get the URL of the source map
  const fileData = retrieveFile(source)
  if (fileData === null) return null

  var re = /(?:\/\/[@#][\s]*sourceMappingURL=([^\s'"]+)[\s]*$)|(?:\/\*[@#][\s]*sourceMappingURL=([^\s*'"]+)[\s]*(?:\*\/)[\s]*$)/mg
  // Keep executing the search to find the *last* sourceMappingURL to avoid
  // picking up sourceMappingURLs from comments, strings, etc.
  let lastMatch: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = re.exec(fileData)) !== null) lastMatch = match
  if (lastMatch === null) return null
  return lastMatch[1]
};

// Can be overridden by the retrieveSourceMap option to install. Takes a
// generated source filename; returns a {map, optional url} object, or null if
// there is no source map.  The map field may be either a string or the parsed
// JSON object (ie, it must be a valid argument to the SourceMapConsumer
// constructor).
function retrieveSourceMap (source: string): SourceMapRaw | null {
  var sourceMappingURL = retrieveSourceMapURL(source)
  if (sourceMappingURL === null) return null

  // Read the contents of the source map
  var sourceMapData
  if (reSourceMap.test(sourceMappingURL)) {
    // Support source map URL as a data url
    var rawData = sourceMappingURL.slice(sourceMappingURL.indexOf(',') + 1)
    sourceMapData = Buffer.from(rawData, 'base64').toString()
    sourceMappingURL = source
  } else {
    // Support source map URLs relative to the source URL
    sourceMappingURL = supportRelativeURL(source, sourceMappingURL)
    sourceMapData = retrieveFile(sourceMappingURL)
  }

  if (sourceMapData === null) {
    return null
  }

  return {
    url: sourceMappingURL,
    map: sourceMapData
  }
}

function mapSourcePosition (source: string, line: number, column: number): MappedPosition | null {
  let sourceMap = sourceMapCache[source]
  if (sourceMap === undefined) {
    // Call the (overrideable) retrieveSourceMap function to get the source map.
    const urlAndMap = retrieveSourceMap(source)
    if (urlAndMap !== null) {
      const consumer = new SourceMapConsumer(urlAndMap.map as any)
      sourceMap = sourceMapCache[source] = {
        url: urlAndMap.url,
        map: consumer
      }

      // Load all sources stored inline with the source map into the file cache
      // to pretend like they are already loaded. They may not exist on disk.

      // @ts-expect-error
      consumer.sources.forEach(function (source: string, i: number) {
        var contents = consumer.sourceContentFor(source, true)
        if (contents === null) return
        var url = supportRelativeURL(urlAndMap.url, source)
        fileContentsCache[url] = contents
      })
    } else {
      sourceMap = sourceMapCache[source] = null
    }
  }

  if (sourceMap === null) return null

  // Resolve the source URL relative to the URL of the source map
  var originalPosition = sourceMap.map.originalPositionFor({ line, column })

  // Only return the original position if a matching line was found. If no
  // matching line is found then we return position instead, which will cause
  // the stack trace to print the path and line for the compiled file. It is
  // better to give a precise location in the compiled file than a vague
  // location in the original file.
  if (originalPosition.source === null) return null

  originalPosition.source = supportRelativeURL(
    sourceMap.url, originalPosition.source)

  line = originalPosition.line ?? line
  column = originalPosition.column ?? column
  source = originalPosition.source ?? source

  return {
    line,
    column,
    source,
    name: originalPosition.name
  }
}

// Parses code generated by FormatEvalOrigin(), a function inside V8:
// https://code.google.com/p/v8/source/browse/trunk/src/messages.js
function mapEvalOrigin (origin: string): string {
  // Most eval() calls are in this format
  var match = /^eval at ([^(]+) \((.+):(\d+):(\d+)\)$/.exec(origin)
  if (match !== null) {
    var position = mapSourcePosition(
      match[2],
      +match[3],
      parseInt(match[4]) - 1
    )
    if (position === null) return origin
    return 'eval at ' + match[1] + ' (' + position.source + ':' +
      position.line?.toString() + ':' + (position.column + 1).toString() + ')'
  }

  // Parse nested eval() calls using recursion
  match = /^eval at ([^(]+) \((.+)\)$/.exec(origin)
  if (match !== null) {
    return 'eval at ' + match[1] + ' (' + mapEvalOrigin(match[2]) + ')'
  }

  // Make sure we still return useful information if we didn't find anything
  return origin
}

function cloneCallSite(frame: NodeJS.CallSite): NodeJS.CallSite {
  // @ts-expect-error
  var object: NodeJS.CallSite = {}
  Object.getOwnPropertyNames(Object.getPrototypeOf(frame)).forEach(function (name) {
    // @ts-expect-error
    // eslint-disable-next-line no-useless-call
    object[name] = /^(?:is|get)/.test(name) ? function () { return frame[name].call(frame) } : frame[name]
  })
  object.toString = CallSiteToString
  return object
}

function wrapCallSite (frame: NodeJS.CallSite, state: { nextPosition: null | MappedPosition, curPosition: null | MappedPosition }): NodeJS.CallSite {
  if (frame.isNative()) {
    state.curPosition = null
    return frame
  }

  // Most call sites will return the source file from getFileName(), but code
  // passed to eval() ending in "//# sourceURL=..." will return the source file
  // from getScriptNameOrSourceURL() instead
  // @ts-expect-error
  const source = frame.getFileName() ?? frame.getScriptNameOrSourceURL() ?? null
  const line = frame.getLineNumber()
  let column = frame.getColumnNumber()

  if (source !== null && line !== null && column !== null) {
    column--

    // Fix position in Node where some (internal) code is prepended.
    // See https://github.com/evanw/node-source-map-support/issues/36
    // Header removed in node at ^10.16 || >=11.11.0
    // v11 is not an LTS candidate, we can just test the one version with it.
    // Test node versions for: 10.16-19, 10.20+, 12-19, 20-99, 100+, or 11.11
    var noHeader = /^v(10\.1[6-9]|10\.[2-9][0-9]|10\.[0-9]{3,}|1[2-9]\d*|[2-9]\d|\d{3,}|11\.11)/
    var headerLength = noHeader.test(process.version) ? 0 : 62
    if (line === 1 && column > headerLength && !frame.isEval()) {
      column -= headerLength
    }

    const position = mapSourcePosition(
      source,
      line,
      column
    )

    if (position === null) {
      return frame
    }

    state.curPosition = position
    frame = cloneCallSite(frame)
    var originalFunctionName = frame.getFunctionName
    frame.getFunctionName = function () {
      if (state.nextPosition == null) {
        return originalFunctionName()
      }
      return state.nextPosition.name ?? originalFunctionName()
    }
    frame.getFileName = () => { return position.source }
    frame.getLineNumber = () => { return position.line }
    frame.getColumnNumber = () => { return position.column + 1 }
    // @ts-expect-error
    frame.getScriptNameOrSourceURL = () => { return position.source }
    return frame
  }

  // Code called using eval() needs special handling
  var origin = frame.isEval() && frame.getEvalOrigin()
  if (origin !== undefined && origin !== false) {
    origin = mapEvalOrigin(origin)
    frame = cloneCallSite(frame)
    // @ts-expect-error
    frame.getEvalOrigin = function () { return origin }
    return frame
  }

  // If we get here then we were unable to change the source position
  return frame
}

// Generate position and snippet of original source with pointer
function getErrorSource (error: Error): null | string {
  if (error.stack === undefined) return null
  var match = /\n {4}at [^(]+ \((.*):(\d+):(\d+)\)/.exec(error.stack)
  if (match !== null) {
    var source = match[1]
    var line = +match[2]
    var column = +match[3]

    // Support the inline sourceContents inside the source map
    var contents = retrieveFile(source)

    if (contents === null) return null

    // Format the line from the original source code like node does
    var code = contents.split(/(?:\r\n|\r|\n)/)[line - 1]
    if (code === undefined) return null

    return source + ':' + line.toString() + '\n' + code + '\n' + new Array(column).join(' ') + '^'
  }
  return null
}

function printErrorAndExit (error: Error): void {
  var source = getErrorSource(error)

  if (source !== null) {
    console.error()
    console.error(source)
  }

  console.error(error.stack)
  process.exit(1)
}

function shimEmitUncaughtException (): void {
  var origEmit = process.emit

  // @ts-expect-error
  process.emit = function (event: string, ...args: any[]) {
    if (event === 'uncaughtException') {
      var hasStack = args[0]?.stack !== undefined
      var hasListeners = (this.listeners(event).length > 0)

      if (hasStack && !hasListeners) {
        return printErrorAndExit(args[0])
      }
    }

    // @ts-expect-error
    return origEmit.call(this, event, ...args)
  }
}

// This function is part of the V8 stack trace API, for more info see:
// https://v8.dev/docs/stack-trace-api
function prepareStackTrace (err: Error, stackTraces: NodeJS.CallSite[]): string {
  if (emptyCacheBetweenOperations) {
    fileContentsCache = {}
    sourceMapCache = {}
  }

  var name = err.name ?? 'Error'
  var message = err.message ?? ''
  var errorString = name + ': ' + message

  var state = { nextPosition: null, curPosition: null }
  var processedStack = []
  for (var i = stackTraces.length - 1; i >= 0; i--) {
    processedStack.push('\n    at ' + (wrapCallSite(stackTraces[i], state) as any as string))
    state.nextPosition = state.curPosition
  }
  state.curPosition = state.nextPosition = null
  return errorString + processedStack.reverse().join('')
}

exports.getErrorSource = getErrorSource

exports.install = function (options?: Options) {
  options = options ?? {}

  // Configure options
  if (!emptyCacheBetweenOperations) {
    emptyCacheBetweenOperations = options.emptyCacheBetweenOperations === true
  }

  // Install the error reformatter
  if (!errorFormatterInstalled) {
    errorFormatterInstalled = true
    Error.prepareStackTrace = prepareStackTrace
  }

  // Support runtime transpilers that include inline source maps
  if (!hookRequireInstalled && options.hookRequire === true) {
    hookRequireInstalled = true
    // @ts-expect-error
    var $compile = Module.prototype._compile
    // @ts-expect-error
    Module.prototype._compile = function (content: string, filename: string) {
      fileContentsCache[filename] = content
      // @ts-expect-error
      sourceMapCache[filename] = undefined
      return $compile.call(this, content, filename)
    }
  }

  if (!uncaughtShimInstalled && options.handleUncaughtExceptions !== false) {
    uncaughtShimInstalled = true
    shimEmitUncaughtException()
  }
}
