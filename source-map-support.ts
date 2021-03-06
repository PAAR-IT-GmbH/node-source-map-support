import { SourceMapConsumer, MappedPosition } from 'source-map-js'
import path from 'path'
import fs from 'fs'
import Module from 'module'

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
  retrieveSourceMap?: (path: string) => SourceMapRaw | null
  retrieveFile?: (path: string) => string | null
  pathSanitize?: (path: string) => string
  stackFilter?: (err: Error, stackTraces: NodeJS.CallSite[]) => boolean
}

// Only prepare stack trace once
let stackTracePrepared = false

// Only hook require once
let requireHooked = false

// Only handle uncaught exceptions once
let uncaughtExceptionsHandled = false

// If true, the caches are reset before a stack trace formatting operation
let emptyCacheBetweenOperations = false

// Handles the source map retrieval, can be overwritten by retrieveSourceMap
let customRetrieveSourceMap = (path: string): SourceMapRaw | null => {
  return retrieveSourceMap(path)
}

// Handles the file retrieval, can be overwritten by retrieveFile
let customRetrieveFile = (path: string): string | null => {
  return retrieveFile(path)
}

// Handles the path sanitation, can be overwritten by pathSanitize
let customPathSanitize = (path: string): string => {
  return pathSanitize(path)
}

// Handles the decision, if source maps should be applied
// eslint-disable-next-line handle-callback-err
let customStackFilter = (_1: Error, _2: NodeJS.CallSite[]): boolean => {
  return true
}

// Maps a file path to a string containing the file contents
let fileContentsCache: { [key: string]: string | null } = {}

// Maps a file path to a source map for that file
let sourceMapCache: { [key: string]: SourceMap | null } = {}

// Regex for detecting source maps
const reSourceMap = /^data:application\/json[^,]+base64,/

export function install (options?: Options): void {
  options = options ?? {}

  customRetrieveSourceMap = options.retrieveSourceMap ?? customRetrieveSourceMap
  customRetrieveFile = options.retrieveFile ?? customRetrieveFile
  customPathSanitize = options.pathSanitize ?? customPathSanitize
  customStackFilter = options.stackFilter ?? customStackFilter

  // Configure options
  emptyCacheBetweenOperations = options.emptyCacheBetweenOperations === true || emptyCacheBetweenOperations

  if (!stackTracePrepared) {
    // Install the error reformatter
    Error.prepareStackTrace = prepareStackTrace
    stackTracePrepared = true
  }

  // Support runtime transpilers that include inline source maps
  if (options.hookRequire === true && !requireHooked) {
    // @ts-expect-error
    const $compile = Module.prototype._compile
    // @ts-expect-error
    Module.prototype._compile = function (content: string, filename: string) {
      fileContentsCache[filename] = content
      // @ts-expect-error
      sourceMapCache[filename] = undefined
      return $compile.call(this, content, filename)
    }
    requireHooked = true
  }

  if (options.handleUncaughtExceptions !== false && !uncaughtExceptionsHandled) {
    shimEmitUncaughtException()
    uncaughtExceptionsHandled = true
  }
}

// Generate position and snippet of original source with pointer
export function getErrorSource (error: Error): null | string {
  if (error.stack === undefined) return null
  const match = /\n {4}at [^(]+ \((.*):(\d+):(\d+)\)/.exec(error.stack)
  if (match !== null) {
    const source = match[1]
    const line = +match[2]
    const column = +match[3]

    // Support the inline sourceContents inside the source map
    const contents = retrieveFileCached(source)

    if (contents === null) return null

    // Format the line from the original source code like node does
    const code = contents.split(/(?:\r\n|\r|\n)/)[line - 1]
    if (code === undefined) return null

    return source + ':' + line.toString() + '\n' + code + '\n' + new Array(column).join(' ') + '^'
  }
  return null
}

export function pathSanitize (path: string): string {
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
  return path
}

export function retrieveFile (path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch (er) {
    /* ignore any errors */
    return null
  }
}

function retrieveFileCached (path: string): string | null {
  path = customPathSanitize(path)
  if (path in fileContentsCache) {
    return fileContentsCache[path]
  }
  const contents = customRetrieveFile(path)
  fileContentsCache[path] = contents
  return contents
}

// Support URLs relative to a directory, but be careful about a protocol prefix
// in case we are in the browser (i.e. directories may start with "http://" or "file:///")
function supportRelativeURL (file: string | null, url: string): string {
  if (file === null) return url
  const dir = path.dirname(file)
  const match = /^\w+:\/\/[^/]*/.exec(dir)
  let protocol = match !== null ? match[0] : ''
  const startPath = dir.slice(protocol.length)
  if (protocol !== '' && /^\/\w:/.test(startPath)) {
    // handle file:///C:/ paths
    protocol += '/'
    return protocol + path.resolve(dir.slice(protocol.length), url).replace(/\\/g, '/')
  }
  return protocol + path.resolve(dir.slice(protocol.length), url)
}

export function retrieveSourceMapURL (source: string): string | null {
  // Get the URL of the source map
  const fileData = retrieveFileCached(source)
  if (fileData === null) return null

  const re = /(?:\/\/[@#][\s]*sourceMappingURL=([^\s'"]+)[\s]*$)|(?:\/\*[@#][\s]*sourceMappingURL=([^\s*'"]+)[\s]*(?:\*\/)[\s]*$)/mg
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
export function retrieveSourceMap (source: string): SourceMapRaw | null {
  let sourceMappingURL = retrieveSourceMapURL(source)
  if (sourceMappingURL === null) return null

  // Read the contents of the source map
  let sourceMapData
  if (reSourceMap.test(sourceMappingURL)) {
    // Support source map URL as a data url
    const rawData = sourceMappingURL.slice(sourceMappingURL.indexOf(',') + 1)
    sourceMapData = Buffer.from(rawData, 'base64').toString()
    sourceMappingURL = source
  } else {
    // Support source map URLs relative to the source URL
    sourceMappingURL = supportRelativeURL(source, sourceMappingURL)
    sourceMapData = retrieveFileCached(sourceMappingURL)
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
    const urlAndMap = customRetrieveSourceMap(source)
    if (urlAndMap !== null) {
      const consumer = (new SourceMapConsumer(urlAndMap.map as any))
      sourceMap = sourceMapCache[source] = {
        url: urlAndMap.url,
        map: consumer
      }

      // Load all sources stored inline with the source map into the file cache
      // to pretend like they are already loaded. They may not exist on disk.
      // @ts-expect-error
      consumer.sources.forEach(function (source: string, i: number) {
        const contents = consumer.sourceContentFor(source, true)
        if (contents === null) return
        const url = supportRelativeURL(urlAndMap.url, source)
        fileContentsCache[url] = contents
      })
    } else {
      sourceMap = sourceMapCache[source] = null
    }
  }

  if (sourceMap === null) return null

  // Resolve the source URL relative to the URL of the source map
  const originalPosition = sourceMap.map.originalPositionFor({ line, column })

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
    name: originalPosition.name ?? undefined
  }
}

// Parses code generated by FormatEvalOrigin(), a function inside V8:
// https://code.google.com/p/v8/source/browse/trunk/src/messages.js
function mapEvalOrigin (origin: string): string {
  // Most eval() calls are in this format
  let match = /^eval at ([^(]+) \((.+):(\d+):(\d+)\)$/.exec(origin)
  if (match !== null) {
    const position = mapSourcePosition(
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

function cloneCallSite (frame: NodeJS.CallSite): NodeJS.CallSite {
  // @ts-expect-error
  const object: NodeJS.CallSite = {}
  Object.getOwnPropertyNames(Object.getPrototypeOf(frame)).forEach(function (name) {
    // @ts-expect-error
    // eslint-disable-next-line no-useless-call
    object[name] = /^(?:is|get)/.test(name) ? function () { return frame[name].call(frame) } : frame[name]
  })
  return object
}

function wrapCallSite (frame: NodeJS.CallSite, state: { nextPosition: null | MappedPosition, curPosition: null | MappedPosition }): string {
  if (frame.isNative()) {
    state.curPosition = null
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return frame.toString()
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
    const noHeader = /^v(10\.1[6-9]|10\.[2-9][0-9]|10\.[0-9]{3,}|1[2-9]\d*|[2-9]\d|\d{3,}|11\.11)/
    const headerLength = noHeader.test(process.version) ? 0 : 62
    if (line === 1 && column > headerLength && !frame.isEval()) {
      column -= headerLength
    }

    const position = mapSourcePosition(
      source,
      line,
      column
    )

    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    if (position === null) return frame.toString()

    state.curPosition = position
    frame = cloneCallSite(frame)
    const originalFunctionName = frame.getFunctionName
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
    return toString(frame)
  }

  // Code called using eval() needs special handling
  let origin = frame.isEval() ? frame.getEvalOrigin() : undefined
  if (origin !== undefined) {
    origin = mapEvalOrigin(origin)
    frame = cloneCallSite(frame)
    frame.getEvalOrigin = function () { return origin }
    return toString(frame)
  }

  // If we get here then we were unable to change the source position
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return frame.toString()
}

function printErrorAndExit (error: Error): void {
  const source = getErrorSource(error)

  if (source !== null) {
    console.error()
    console.error(source)
  }

  console.error(error.stack)
  process.exit(1)
}

function shimEmitUncaughtException (): void {
  const origEmit = process.emit

  // @ts-expect-error
  process.emit = function (event: string, ...args: any[]) {
    if (event === 'uncaughtException') {
      const hasStack = args[0]?.stack !== undefined
      const hasListeners = (this.listeners(event).length > 0)

      if (hasStack && !hasListeners) {
        return printErrorAndExit(args[0])
      }
    }

    // @ts-expect-error
    return origEmit.call(this, event, ...args)
  }
}

// This function is part of the V8 stack trace API, for more info see:
// https://github.com/v8/v8/wiki/Stack-Trace-API
function prepareStackTrace (err: Error, stackTraces: NodeJS.CallSite[]): string {
  if (emptyCacheBetweenOperations) {
    fileContentsCache = {}
    sourceMapCache = {}
  }

  const name = err.name ?? 'Error'
  const message = err.message ?? ''
  const errorString = name + ': ' + message

  const state = { nextPosition: null, curPosition: null }

  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const wrap = customStackFilter(err, stackTraces)

  const processedStack = new Array(stackTraces.length)
  for (let i = stackTraces.length - 1; i >= 0; i--) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    processedStack[i] = '\n    at ' + (wrap ? wrapCallSite(stackTraces[i], state) : stackTraces[i].toString())
    state.nextPosition = state.curPosition
  }
  state.curPosition = state.nextPosition = null
  return errorString + processedStack.join('')
}

// This is copied almost verbatim from the V8 source code at
// https://code.google.com/p/v8/source/browse/trunk/src/messages.js. The
// implementation of wrapCallSite() used to just forward to the actual source
// code of CallSite.prototype.toString but unfortunately a new release of V8
// did something to the prototype chain and broke the shim. The only fix I
// could find was copy/paste.
function toString (frame: NodeJS.CallSite): string {
  let fileName: string
  let fileLocation = ''
  if (frame.isNative()) {
    fileLocation = 'native'
  } else {
    // @ts-expect-error
    fileName = frame.getScriptNameOrSourceURL() ?? ''
    if (fileName === '' && frame.isEval()) {
      fileLocation = frame.getEvalOrigin() ?? ''
      fileLocation += ', ' // Expecting source position to follow.
    }

    if (fileName !== '') {
      fileLocation += fileName
    } else {
      // Source code does not originate from a file and is not native, but we
      // can still get the source position inside the source string, e.g. in
      // an eval string.
      fileLocation += '<anonymous>'
    }
    const lineNumber = frame.getLineNumber()
    if (lineNumber !== null) {
      fileLocation += ':' + lineNumber.toString()
      const columnNumber = frame.getColumnNumber()
      if (columnNumber !== null) {
        fileLocation += ':' + columnNumber.toString()
      }
    }
  }

  let line = ''
  const functionName = frame.getFunctionName()
  let addSuffix = true
  const isConstructor = frame.isConstructor()
  const isMethodCall = !(frame.isToplevel() || isConstructor)
  if (isMethodCall) {
    const typeName = frame.getTypeName()
    const methodName = frame.getMethodName()
    if (functionName !== null) {
      if (typeName !== null && functionName.indexOf(typeName) !== 0) {
        line += typeName + '.'
      }
      line += functionName
      if (methodName !== null && functionName.indexOf('.' + methodName) !== functionName.length - methodName.length - 1) {
        line += ' [as ' + methodName + ']'
      }
    } else {
      line += (typeName ?? '') + '.' + (methodName ?? '<anonymous>')
    }
  } else if (isConstructor) {
    line += 'new ' + (functionName ?? '<anonymous>')
  } else if (functionName !== null) {
    line += functionName
  } else {
    line += fileLocation
    addSuffix = false
  }
  if (addSuffix) {
    line += ' (' + fileLocation + ')'
  }
  return line
}
