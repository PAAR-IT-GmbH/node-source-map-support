
// This is copied almost verbatim from the V8 source code at
// https://code.google.com/p/v8/source/browse/trunk/src/messages.js. The
// implementation of wrapCallSite() used to just forward to the actual source
// code of CallSite.prototype.toString but unfortunately a new release of V8
// did something to the prototype chain and broke the shim. The only fix I
// could find was copy/paste.
module.exports = function () {
    var fileName
    var fileLocation = ''
    if (this.isNative()) {
      fileLocation = 'native'
    } else {
      fileName = this.getScriptNameOrSourceURL()
      if (!fileName && this.isEval()) {
        fileLocation = this.getEvalOrigin()
        fileLocation += ', ' // Expecting source position to follow.
      }
  
      if (fileName) {
        fileLocation += fileName
      } else {
        // Source code does not originate from a file and is not native, but we
        // can still get the source position inside the source string, e.g. in
        // an eval string.
        fileLocation += '<anonymous>'
      }
      var lineNumber = this.getLineNumber()
      if (lineNumber != null) {
        fileLocation += ':' + lineNumber
        var columnNumber = this.getColumnNumber()
        if (columnNumber) {
          fileLocation += ':' + columnNumber
        }
      }
    }
  
    var line = ''
    var functionName = this.getFunctionName()
    var addSuffix = true
    var isConstructor = this.isConstructor()
    var isMethodCall = !(this.isToplevel() || isConstructor)
    if (isMethodCall) {
      var typeName = this.getTypeName()
      // Fixes shim to be backward compatable with Node v0 to v4
      if (typeName === '[object Object]') {
        typeName = 'null'
      }
      var methodName = this.getMethodName()
      if (functionName) {
        if (typeName && functionName.indexOf(typeName) != 0) {
          line += typeName + '.'
        }
        line += functionName
        if (methodName && functionName.indexOf('.' + methodName) != functionName.length - methodName.length - 1) {
          line += ' [as ' + methodName + ']'
        }
      } else {
        line += typeName + '.' + (methodName || '<anonymous>')
      }
    } else if (isConstructor) {
      line += 'new ' + (functionName || '<anonymous>')
    } else if (functionName) {
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