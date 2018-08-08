const most = require('most')
const withLatestFrom = require('../../utils/observable-utils/withLatestFrom')
const holdUntil = require('../../utils/observable-utils/holdUntil')
const delayFromObservable = require('../../utils/observable-utils/delayFromObservable')
const getParameterValuesFromUIControls = require('@jscad/core/parameters/getParameterValuesFromUIControls')
const {nth, toArray} = require('@jscad/core/utils/arrays')
const {omit, keep, atKey} = require('../../utils/object')
const {fetchUriParams, getAllUriParams} = require('../../utils/urlUtils')
const path = require('path')

const {getDesignEntryPoint, getDesignName} = require('../../core/code-loading/requireDesignUtilsFs')

const {availableExportFormatsFromSolids, exportFilePathFromFormatAndDesign} = require('../../core/io/exportUtils')
const packageMetadata = require('../../../package.json')

// what fields should we check to determine if two designs are the same
const designEqualityFields = [
  'parameterDefinitions',
  'parameterValues',
  'mainPath',
  'filesAndFolders',
  'vtreeMode' // also trigger a recompute when vtree mode is enabled/ disabled
]

// what fields we want to de/serialize
const serializableFields = [
  'name',
  'mainPath',
  'origin',
  'parameterValues',
  'vtreeMode',
  'autoReload',
  'instantUpdate',
  'solidsTimeOut'
]

const reducers = {
  /** initialise the design's state
   * @returns {Object} the default state for designs
   */
  initialize: (state) => {
    const design = {
      // metadata
      name: '',
      path: '',
      mainPath: '',
      origin: undefined, // where the design came from : http, local etc
      filesAndFolders: [], // file tree, of sorts
      // code
      instantUpdate: true,
      autoReload: true,
      // if set to true, will overwrite existing code with the converted imput
      // if set to false, will create a script with an import of the input
      convertSupportedTypes: false,
      // parameters
      parameterDefinitions: [],
      parameterValues: {},
      parameterDefaults: {},
      // solids
      solidsTimeOut: 80000,
      solids: [],
      // geometry caching
      vtreeMode: false,
      lookup: {},
      lookupCounts: {},
      debug: {
        startTime: 0,
        endTime: 0,
        totalTime: 0
      }
    }
    return {design}
  },

  /** reset the content of the design
   * @param  {Object} state
   * @param  {String} payload
   * @returns {Object} the updated state
   */
  resetDesign: (state, origin) => {
    console.log('design: reset')
    // we reset only the given fields
    const fieldsToReset = [
      'name', 'path', 'mainPath', 'origin', 'filesAndFolders',
      'parameterDefinitions', 'parameterValues', 'parameterDefaults',
      'lookup', 'lookupCounts', 'debug', 'solids'
    ]
    let design = Object.assign({},
      state.design, keep(fieldsToReset, reducers.initialize().design)
    )
    // ugh
    design.origin = origin
    return {design}
  },

/** set the content of the design usually after a reset
 * bulk of the data is set here
 * @param  {Object} state
 * @param  {String} payload
 * @returns {Object} the updated state
 */
  setDesignContent: (state, payload) => {
    console.log('design: set content', state.design, payload)
   // all our available data (specific to web)
    const {filesAndFolders} = payload
    const makeFakeFs = require('../../sideEffects/memFs/makeFakeFs')
    const fakeFs = makeFakeFs(filesAndFolders)
    const rootPath = payload.path
    const mainPath = getDesignEntryPoint(fakeFs, () => {}, rootPath)
    const designName = getDesignName(fakeFs, rootPath)
    const designPath = path.dirname(rootPath)

    let design = state.design
    // to track computation time
    const debug = Object.assign({ }, state.design.debug, {startTime: new Date()})

    design = Object.assign({}, design, {
      name: designName,
      path: designPath,
      mainPath,
      filesAndFolders,
      debug
    })

    const viewer = Object.assign({}, state.viewer, {behaviours: {resetViewOn: [''], zoomToFitOn: ['new-entities']}})
    const appTitle = `jscad v ${packageMetadata.version}: ${state.design.name}`

    // FIXME: this is the same as clear errors ?
    const status = Object.assign({}, state.status, {busy: true, error: undefined})
    return {
      design,
      viewer,
      appTitle,
      status
    }
  },

  /** set the solids (2d/ 3D /csg/cag data), and the geometry cache if applicable
   * @param  {} state
   * @param  {} {solids
   * @param  {} lookup
   * @param  {} lookupCounts}
   * @returns {Object} the updated state
   */
  setDesignSolids: (state, {solids, lookup, lookupCounts}) => {
    console.log('setDesignSolids')
    solids = solids || []
    lookup = lookup || {}
    lookupCounts = lookupCounts || {}

    // should debug be part of status ?
    const endTime = new Date()
    const totalTime = endTime - state.design.debug.startTime
    const debug = Object.assign({ }, state.design.debug, {
      endTime,
      totalTime
    })
    console.warn(`total time for design regeneration`, totalTime, new Date().getSeconds())

    const design = Object.assign({}, state.design, {
      solids,
      lookup,
      lookupCounts,
      debug
    })

  // TODO: move this to IO ??
    const {exportFormat, availableExportFormats} = availableExportFormatsFromSolids(solids)
    const exportInfos = exportFilePathFromFormatAndDesign(design, exportFormat)
    const io = {
      exportFormat,
      exportFilePath: exportInfos.exportFilePath, // default export file path
      availableExportFormats
    }

    const status = Object.assign({}, state.status, {busy: false})

    return {
      design,
      status,
      io
    }
  },

/** set the parameters of this design
 * @param  {Object} state
 * @param  {} {parameterDefaults
 * @param  {} parameterValues
 * @param  {} parameterDefinitions}
 * @returns {Object} the updated state
 */
  setDesignParameters: (state, data) => {
    console.log('setDesignParameters', data, JSON.stringify(data.parameterValues))
    const applyParameterDefinitions = require('@jscad/core/parameters/applyParameterDefinitions')
    const parameterDefaults = data.parameterDefaults || state.design.parameterDefaults
    const parameterDefinitions = data.parameterDefinitions || state.design.parameterDefinitions
    // this ensures the last, manually modified params have upper hand
    let parameterValues = data.parameterValues || parameterDefaults || state.design.parameterValues
    parameterValues = parameterValues ? applyParameterDefinitions(parameterValues, parameterDefinitions) : parameterValues

    // one of many ways of filtering out data from instantUpdates
    if (data.origin === 'instantUpdate' && !state.design.instantUpdate) {
      parameterValues = state.design.parameterValues
    }

    let design = Object.assign({}, state.design, {
      parameterDefaults,
      parameterValues,
      parameterDefinitions,
      parametersOrigin: data.origin
    })
    // to track computation time
    if (data.origin !== 'worker') {
      const debug = Object.assign({ }, state.design.debug, {startTime: new Date()})
      design = Object.assign({}, design, {debug})
      console.warn('start', new Date().getSeconds())
    }

    const status = Object.assign({}, state.status, {busy: true, error: undefined})

    return {
      design,
      status
    }
  },

  setDesignSettings: (state, {data}) => {
    let {
      vtreeMode,
      autoReload,
      instantUpdate,
      solidsTimeOut
    } = data
    // FIXME : clunky but needed to make sure we have no invalid settings
    if (vtreeMode === undefined) {
      return {design: state.design}
    }
    const design = Object.assign({}, state.design, {vtreeMode, autoReload, instantUpdate, solidsTimeOut})
    return {
      design
    }
  },

  requestGeometryRecompute: ({design}, _) => {
    return keep(['mainPath', 'parameterValues', 'filesAndFolders', 'vtreeMode', 'lookup', 'lookupCounts'], design)
  },

  timeoutGeometryRecompute: ({status}, _) => {
    if (status.isBusy) { // still computing... we can kill it
      return Object.assign({}, status, {
        busy: false,
        error: new Error('Failed to generate design within an acceptable time, bailing out')
      })
    }
    // no problem, just act as a no-op
    return {status}
  },
  requestWriteCachedGeometry: (cache) => {
    const serialize = require('serialize-to-js').serialize
    let data = {}
    Object.keys(cache).forEach(function (key) {
      data[key] = cache[key]
    })
    // we want to save the geometry cache under '.solidsCache'
    return { data: serialize(data), path: '.solidsCache', options: {isRawData: true} }
  },
  // what do we want to save , return an object containing only that data?
  requestSaveSettings: ({design}) => {
    return keep(serializableFields, design)
  },
  // helpers
  isDesignValid: state => {
    return state.design && state.design.name && state.design.path !== ''
  },
  // determine if a design has remained the same : does NOT include solids, as they are a result of all the other parameters
  isDesignTheSame: (previousState, state) => {
    if (!previousState.design) {
      return false
    }
    // console.log('isDesignTheSame', previousState.design, state.design)

    const current = JSON.stringify(keep(designEqualityFields, state.design))
    const previous = JSON.stringify(keep(designEqualityFields, previousState.design))
    return previous === current
  },
  // same as above but with added fields for settings
  isDesignTheSameForSerialization: (previousState, state) => {
    if (!previousState.design) {
      return false
    }
    // do a JSON compare of the previous & current fields to save if needed
    const current = JSON.stringify(keep(serializableFields, state.design))
    const previous = JSON.stringify(keep(serializableFields, previousState.design))
    return previous === current
  },

  // ui/toggles
  toggleAutoReload: (state, autoReload) => {
    // console.log('toggleAutoReload', autoReload)
    const design = Object.assign({}, state.design, {autoReload})
    return {design}
  },
  toggleInstantUpdate: (state, instantUpdate) => {
    // console.log('toggleInstantUpdate', instantUpdate)
    const design = Object.assign({}, state.design, {instantUpdate})
    return {design}
  },
  toggleVtreeMode: (state, vtreeMode) => {
    // console.log('toggleVtreeMode', vtreeMode)
    const design = Object.assign({}, state.design, {vtreeMode})
    return {design}
  },
  setSolidsTimeout: (state, solidsTimeOut) => {
    // console.log('setSolidsTimeout', solidsTimeOut)
    const design = Object.assign({}, state.design, {solidsTimeOut})
    return {design}
  }
}

const actions = ({sources}) => {
  const initialize$ = most.just({})
    .thru(withLatestFrom(reducers.initialize, sources.state))
    .map(data => ({type: 'initializeDesign', state: data, sink: 'state'}))

  // we wait until the data here has been initialized before loading the serialized settings
  const requestLoadSettings$ = initialize$
    .map(_ => ({sink: 'store', key: 'design', type: 'read'}))

  // starts emmiting to storage only AFTER initial settings have been loaded
  const requestSaveSettings$ = sources.state
    .filter(state => state.design)
    .skipRepeatsWith(reducers.isDesignTheSameForSerialization)
    .skip(1) // we do not care about the first state change
    .thru(holdUntil(sources.store.filter(reply => reply.key === 'design' && reply.type === 'read')))
    .map(reducers.requestSaveSettings)
    .map(data => Object.assign({}, {data}, {sink: 'store', key: 'design', type: 'write'}))
    .multicast()

  const setDesignSettings$ = sources.store
    .filter(reply => reply.key === 'design' && reply.type === 'read' && reply.data !== undefined)
    .thru(withLatestFrom(reducers.setDesignSettings, sources.state))
    .map(data => ({type: 'setDesignSettings', state: data, sink: 'state'}))
    .multicast()

  const requestLoadRemoteData$ = most.mergeArray([
      // load examples when clicked
    sources.dom.select('.example').events('click')
      .map(event => event.target.dataset.path),
      // remote, via proxy, adresses of files passed via url
    sources.titleBar
      .filter(x => x !== undefined)
      .map(url => {
        const params = getAllUriParams(url)
        const useProxy = params.proxyUrl !== undefined || url.match(/#(https?:\/\/\S+)$/) !== null
        const documentUri = fetchUriParams(url, 'uri', undefined) || nth(1, url.match(/#(https?:\/\/\S+)$/)) || nth(1, document.URL.match(/#(examples\/\S+)$/))
        const baseUri = window.location.origin // location.protocol + '//' + location.host + location.pathname
        // console.log('useProxy', useProxy, documentUri, baseUri)
        const documentUris = documentUri ? [documentUri] : undefined
        return documentUris
      })
  ])
    .filter(x => x !== undefined)
    .map(data => ({type: 'read', id: 'loadRemote', urls: toArray(data), sink: 'http'}))
    .multicast()

  const requestLoadLocalData = most.mergeArray([
    /* sources.dom.select('#fileLoader').events('click')
    .map(function () {
      // literally an array of paths (strings)
      // like those returned by dialog.showOpenDialog({properties: ['openFile', 'openDirectory', 'multiSelections']})
      const paths = []
      return paths
    }), */
  ])

  const requestAddDesignData$ = most.mergeArray([
      // injection from drag & drop
    sources.drops
      .map(({data}) => ({data, id: 'droppedData', path: 'realFs:'})),
      // data retrieved from http requests
    sources.http
      .filter(response => response.id === 'loadRemote' && response.type === 'read' && !('error' in response))
      .map(({data, url}) => ({data, id: 'remoteFile', path: url, options: {isRawData: true}}))
  ])
    .map(payload => Object.assign({}, {type: 'add', sink: 'fs'}, payload))
    .multicast()

  const requestWatchDesign$ = most.mergeArray([
      // watched data
    sources.state
      .filter(state => state.design && state.design.mainPath !== '')
      .map(state => ({path: state.design.mainPath, enabled: state.design.autoReload}))
      .skipRepeatsWith((state, previousState) => {
        return JSON.stringify(state) === JSON.stringify(previousState)
      })
      .map(({path, enabled}) => ({
        id: 'watchScript',
        path,
        options: {enabled}})// enable/disable watch if autoreload is set to false
      )
  ])
    .map(payload => Object.assign({}, {type: 'watch', sink: 'fs'}, payload))
    .multicast()

  const requestWriteCachedGeometry$ = most.mergeArray([
    sources.state
      .filter(state => state.design && state.design.mainPath !== '')
      .skipRepeatsWith((state, previousState) => state.design === previousState.design)
      .map(state => state.design.solids)
      .filter(solids => solids !== undefined)
      .skipRepeatsWith((state, previousState) => {
        return JSON.stringify(state) === JSON.stringify(previousState)
      })
      .map(reducers.requestWriteCachedGeometry)
      .map(payload => Object.assign({}, {type: 'write', sink: 'fs', id: 'cachedGeometry'}, payload))
    /* most.just()
      .map(function () {
        const electron = require('electron').remote
        const userDataPath = electron.app.getPath('userData')
        const path = require('path')

        const cachePath = path.join(userDataPath, '/cache.js')
        // const cachePath = 'gnagna'
        return {type: 'write', id: 'loadCachedGeometry', path: cachePath}
      }) */
  ])
    .map(payload => Object.assign({}, {type: 'write', sink: 'fs'}, payload))
    .multicast()

  const resetDesign$ = most.mergeArray([
    requestLoadRemoteData$.map(_ => 'http'),
    sources.drops.map(_ => 'local')
  ])
    .thru(withLatestFrom(reducers.resetDesign, sources.state))
    .map(data => ({type: 'setDesignSettings', state: data, sink: 'state'}))
    .multicast()

  const setDesignContent$ = most.mergeArray([
    sources.fs
      .filter(response => response.type === 'add')
      .map(({data}) => ({filesAndFolders: data, path: data[0].fullPath})).delay(100)
      ,
    sources.fs
      .filter(response => response.type === 'watch' && response.id === 'watchFiles')
      .map(({path, filesAndFolders}) => ({path, filesAndFolders, flag: 'update'}))
  ])
    .thru(withLatestFrom(reducers.setDesignContent, sources.state))
    .map(data => ({type: 'setDesignContent', state: data, sink: 'state'}))

  const setDesignSolids$ = most.mergeArray([
    sources.solidWorker
      .filter(event => !('error' in event))
      .filter(event => event.data instanceof Object)
      .filter(event => event.data.type === 'solids')
      .map(function (event) {
        try {
          if (event.data instanceof Object) {
            const start = new Date()
            const { CAG, CSG } = require('@jscad/csg')
            const solids = event.data.solids.map(function (object) {
              if (object['class'] === 'CSG') { return CSG.fromCompactBinary(object) }
              if (object['class'] === 'CAG') { return CAG.fromCompactBinary(object) }
            })
            const {lookupCounts, lookup} = event.data
            console.warn(`elapsed for csg gen ${new Date() - start}`)
            return {solids, lookup, lookupCounts}
          }
        } catch (error) {
          return {error}
        }
      })
      .multicast(),
    sources.fs
      .filter(res => res.type === 'read' && res.id === 'loadCachedGeometry' && res.data)
      .map(raw => {
        console.log('loading cached ')
        const deserialize = () => {}// require('serialize-to-js').deserialize
        const lookup = deserialize(raw.data)
        return {solids: undefined, lookupCounts: undefined, lookup}
      })
      .multicast()
  ])
    .thru(withLatestFrom(reducers.setDesignSolids, sources.state))
    .map(data => ({type: 'setDesignSolids', state: data, sink: 'state'}))
    .multicast()

  // send out a request to recompute the geometry
  const requestGeometryRecompute$ = sources.state
    .skipRepeatsWith(reducers.isDesignTheSame)
    .filter(reducers.isDesignValid)
    .map(reducers.requestGeometryRecompute)
    .map(payload => Object.assign({}, payload, {sink: 'geometryWorker', cmd: 'generate'}))
    .multicast()

  // every time we send out a request to recompute geometry, we initiate a timeout
  // we debounce these timeouts so that it reset the timeout everytime there is a new request
  // to recompute
  const timeoutGeometryRecompute$ = requestGeometryRecompute$
    .thru(delayFromObservable(state => state.design.solidsTimeOut, sources.state.filter(state => state.design)))
    .thru(withLatestFrom(reducers.timeoutGeometryRecompute, sources.state))
    .map(payload => Object.assign({}, {state: payload}, {sink: 'state', type: 'timeOutDesignGeneration'}))
    .multicast()

  // we also re-use the timeout to send a signal to the worker to terminate the current geometry generation
  const cancelGeometryRecompute$ = timeoutGeometryRecompute$
    .filter(({state}) => state.status.error !== undefined)// if there was no error , the timeout is irrelevant
    .map(_ => Object.assign({}, {sink: 'geometryWorker', cmd: 'cancel'}))
    .multicast()

  // design parameter change actions
  const getControls = () => Array.from(document.getElementById('paramsTable').getElementsByTagName('input'))
    .concat(Array.from(document.getElementById('paramsTable').getElementsByTagName('select')))

  const parametersFromDom$ = most.mergeArray([
    sources.dom.select('#updateDesignFromParams').events('click')
      .map(function () {
        const controls = getControls()
        const parameterValues = getParameterValuesFromUIControls(controls)
        return {parameterValues, origin: 'uiManualUpdate'}
      })
      .multicast(),
    sources.paramChanges.multicast()
      .map(function () {
        try {
          const controls = getControls()
          const parameterValues = getParameterValuesFromUIControls(controls)
          return {parameterValues, origin: 'uiInstantUpdate'}
        } catch (error) {
          return {error, origin: 'instantUpdate'}
        }
      })
  ])
    .multicast()

  // parameter values etc retrived from local storage
  const parametersFromStore$ = sources.store
    .filter(reply => reply.key === 'design' && reply.type === 'read' &&
      reply.data.parameterValues !== undefined
    )
    .map(({data}) => ({parameterValues: data.parameterValues, origin: 'store'}))
    .multicast()

  // parameter values retrived from titleBar
  const parametersFromTitleBar$ = sources.titleBar
    .map(uri => {
      let params = getAllUriParams(uri)
      // console.log('params from titleBar ?', uri, params)
      const parameterValues = params
      return {parameterValues, origin: 'titleBar'}
    })

  // parameter defaults & definitions retrieved from worker
  const parametersFromWorker$ = sources.solidWorker
    .filter(event => !('error' in event))
    .filter(event => event.data instanceof Object)
    .filter(event => event.data.type === 'params')
    .map(({data}) => {
      try {
        const {parameterDefaults, parameterDefinitions} = data
        return {parameterDefaults, parameterDefinitions, origin: 'worker'}
      } catch (error) {
        return {error}
      }
    })

  const setDesignParameters$ = most.mergeArray([
    // from ui
    parametersFromDom$,
    // from storage
    parametersFromStore$,
    // from worker
    parametersFromWorker$,
    // parameter values specified via the titleBar
    parametersFromTitleBar$
  ])
    .thru(holdUntil(sources.state.filter(reducers.isDesignValid)))
    .thru(withLatestFrom(reducers.setDesignParameters, sources.state))
    .skipRepeatsWith((cur, prev) => {
      console.log('params change', cur, prev)
      cur = cur.design
      prev = prev.design
      return JSON.stringify(cur.parameterValues) === JSON.stringify(prev.parameterValues)
      && JSON.stringify(cur.parameterDefinitions) === JSON.stringify(prev.parameterDefinitions)
    })
    .map(data => ({type: 'setDesignParameters', state: data, sink: 'state'}))
    .multicast()

  // FIXME: this needs to be elsewhere
  // const setZoomingBehaviour$ = ''
  // setDesignContent$.map(x=>{behaviours: {resetViewOn: [''], zoomToFitOn: ['new-entities']})
  // ui/toggles
  const toggleAutoReload$ = most.mergeArray([
    sources.dom.select('#autoReload').events('click')
      .map(e => e.target.checked)
  ])
    .thru(withLatestFrom(reducers.toggleAutoReload, sources.state))
    .map(data => ({type: 'toggleAutoReload', state: data, sink: 'state'}))

  const toggleInstantUpdate$ = most.mergeArray([
    sources.dom.select('#instantUpdate').events('click').map(event => event.target.checked)
  ])
    .thru(withLatestFrom(reducers.toggleInstantUpdate, sources.state))
    .map(data => ({type: 'toggleInstantUpdate', state: data, sink: 'state'}))

  const toggleVTreeMode$ = most.mergeArray([
    sources.dom.select('#toggleVtreeMode').events('click').map(event => event.target.checked)
  ])
    .thru(withLatestFrom(reducers.toggleVtreeMode, sources.state))
    .map(data => ({type: 'toggleVtreeMode', state: data, sink: 'state'}))

  const setSolidsTimeout$ = most.mergeArray([
    sources.dom.select('#solidsTimeout').events('change').map(event => event.target.value)
      .map(value => parseFloat(value))
  ])
    .thru(withLatestFrom(reducers.setSolidsTimeout, sources.state))
    .map(data => ({type: 'setSolidsTimeout', state: data, sink: 'state'}))

  return {
    initialize$,

    requestLoadRemoteData$,
    requestAddDesignData$,
    requestWatchDesign$,
    requestWriteCachedGeometry$,

    resetDesign$,
    setDesignContent$,

    requestGeometryRecompute$,
    timeoutGeometryRecompute$,
    cancelGeometryRecompute$,
    setDesignSolids$,
    setDesignParameters$,

    requestLoadSettings$,
    requestSaveSettings$,
    setDesignSettings$,

    // ui related
    toggleAutoReload$,
    toggleInstantUpdate$,
    toggleVTreeMode$,
    setSolidsTimeout$

    // setDesignOrigins$
  }
}

module.exports = actions
