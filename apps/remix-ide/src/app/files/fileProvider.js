'use strict'

import { CompilerImports } from '@remix-project/core-plugin'
import { ConsoleLogs } from 'libs/remix-lib/src/helpers/hhconsoleSigs'
const EventManager = require('events')
const modalDialogCustom = require('../ui/modal-dialog-custom')
const tooltip = require('../ui/tooltip')
const remixLib = require('@remix-project/remix-lib')
const Storage = remixLib.Storage

class FileProvider {
  constructor (name) {
    this.event = new EventManager()
    this.type = name
    this.providerExternalsStorage = new Storage('providerExternals:')
    this.externalFolders = [this.type + '/swarm', this.type + '/ipfs', this.type + '/github', this.type + '/gists', this.type + '/https']
    this.reverseKey = this.type + '-reverse-'
  }

  addNormalizedName (path, url) {
    this.providerExternalsStorage.set(this.type + '/' + path, url)
    this.providerExternalsStorage.set(this.reverseKey + url, this.type + '/' + path)
  }

  removeNormalizedName (path) {
    const value = this.providerExternalsStorage.get(path)
    this.providerExternalsStorage.remove(path)
    this.providerExternalsStorage.remove(this.reverseKey + value)
  }

  normalizedNameExists (path) {
    return this.providerExternalsStorage.exists(path)
  }

  getNormalizedName (path) {
    return this.providerExternalsStorage.get(path)
  }

  getPathFromUrl (url) {
    return this.providerExternalsStorage.get(this.reverseKey + url)
  }

  getUrlFromPath (path) {
    if (!path.startsWith(this.type)) path = this.type + '/' + path
    return this.providerExternalsStorage.get(path)
  }

  isExternalFolder (path) {
    return this.externalFolders.includes(path)
  }

  discardChanges (path) {
    this.remove(path)
    const compilerImport = new CompilerImports()
    this.providerExternalsStorage.keys().map(value => {
      if (value.indexOf(path) === 0) {
        compilerImport.import(
          this.getNormalizedName(value),
          true,
          (loadingMsg) => { tooltip(loadingMsg) },
          async (error, content, cleanUrl, type, url) => {
            if (error) {
              modalDialogCustom.alert(error)
            } else {
              await this.addExternal(type + '/' + cleanUrl, content, url)
            }
          }
        )
      }
    })
  }

  async exists (path) {
    // todo check the type (directory/file) as well #2386
    // currently it is not possible to have a file and folder with same path
    const ret = await this._exists(path)

    return ret
  }

  async _exists (path) {
    path = this.getPathFromUrl(path) || path // ensure we actually use the normalized path from here
    var unprefixedpath = this.removePrefix(path)
    return path === this.type ? true : await window.remixFileSystem.exists(unprefixedpath)
  }

  init (cb) {
    cb()
  }

  async get (path, cb) {
    path = this.getPathFromUrl(path) || path // ensure we actually use the normalized path from here
    var unprefixedpath = this.removePrefix(path)
    try {
      const content = await window.remixFileSystem.readFile(unprefixedpath, 'utf8')
      if (cb) cb(null, content)
      return content
    } catch (err) {
      if (cb) cb(err, null)
      throw new Error(err)
    }
  }

  async set (path, content, cb) {
    var unprefixedpath = this.removePrefix(path)
    const exists = await window.remixFileSystem.exists(unprefixedpath)
    if (exists && await window.remixFileSystem.readFile(unprefixedpath, 'utf8') === content) {
      if (cb) cb()
      return null
    }

    await this.createDir(path.substr(0, path.lastIndexOf('/')))
    try {
      await window.remixFileSystem.writeFile(unprefixedpath, content, 'utf8')
    } catch (e) {
      if (cb) cb(e)
      return false
    }
    if (!exists) {
      this.event.emit('fileAdded', this._normalizePath(unprefixedpath), false)
    } else {
      this.event.emit('fileChanged', this._normalizePath(unprefixedpath))
    }
    if (cb) cb()
    return true
  }

  async createDir (path, cb) {
    const unprefixedpath = this.removePrefix(path)
    const paths = unprefixedpath.split('/')
    if (paths.length && paths[0] === '') paths.shift()
    let currentCheck = ''
    for (const value of paths) {
      currentCheck = currentCheck + '/' + value
      if (!await window.remixFileSystem.exists(currentCheck)) {
        try {
          await window.remixFileSystem.mkdir(currentCheck)
          console.log('folder add', currentCheck, this._normalizePath(currentCheck))
          this.event.emit('folderAdded', this._normalizePath(currentCheck))
          console.log("folderd added")
        } catch (error) {
          console.log(error)
        }
      }
    }
    if (cb) cb()
  }

  // this will not add a folder as readonly but keep the original url to be able to restore it later
  async addExternal (path, content, url) {
    if (url) this.addNormalizedName(path, url)
    return await this.set(path, content)
  }

  isReadOnly (path) {
    return false
  }

  async isDirectory (path) {
    const unprefixedpath = this.removePrefix(path)
    return path === this.type ? true : (await window.remixFileSystem.stat(unprefixedpath)).isDirectory()
  }

  async isFile (path) {
    path = this.getPathFromUrl(path) || path // ensure we actually use the normalized path from here
    path = this.removePrefix(path)
    return (await window.remixFileSystem.stat(path)).isFile()
  }

  /**
   * Removes the folder recursively
   * @param {*} path is the folder to be removed
   */
  async remove (path) {
    path = this.removePrefix(path)
    if (await window.remixFileSystem.exists(path)) {
      const stat = await window.remixFileSystem.stat(path)
      try {
        if (!stat.isDirectory()) {
          return (this.removeFile(path))
        } else {
          const items = await window.remixFileSystem.readdir(path)
          if (items.length !== 0) {
            for (const item of items) {
              const curPath = `${path}${path.endsWith('/') ? '' : '/'}${item}`
              if ((await window.remixFileSystem.stat(curPath)).isDirectory()) { // delete folder
                await this.remove(curPath)
              } else { // delete file
                await this.removeFile(curPath)
              }
            }
            await window.remixFileSystem.rmdir(path)
          } else {
            // folder is empty
            await window.remixFileSystem.rmdir(path)
          }
          this.event.emit('fileRemoved', this._normalizePath(path))
        }
      } catch (e) {
        console.log(e)
        return false
      }
    }
  }

  /**
   * copy the folder recursively (internal use)
   * @param {string} path is the folder to be copied over
   * @param {Function} visitFile is a function called for each visited files
   * @param {Function} visitFolder is a function called for each visited folders
   */
  async _copyFolderToJsonInternal (path, visitFile, visitFolder) {
    visitFile = visitFile || (() => { })
    visitFolder = visitFolder || (() => { })

    const json = {}
    path = this.removePrefix(path)
    if (await window.remixFileSystem.exists(path)) {
      try {
        const items = await window.remixFileSystem.readdir(path)
        visitFolder({ path })
        if (items.length !== 0) {
          for (const item of items) {
            const file = {}
            const curPath = `${path}${path.endsWith('/') ? '' : '/'}${item}`
            if ((await window.remixFileSystem.stat(curPath)).isDirectory()) {
              file.children = await this._copyFolderToJsonInternal(curPath, visitFile, visitFolder)
            } else {
              file.content = await window.remixFileSystem.readFile(curPath, 'utf8')
              visitFile({ path: curPath, content: file.content })
            }
            json[curPath] = file
          }
        }
      } catch (e) {
        console.log(e)
        throw new Error(e)
      }
    }
    return json
  }

  /**
   * copy the folder recursively
   * @param {string} path is the folder to be copied over
   * @param {Function} visitFile is a function called for each visited files
   * @param {Function} visitFolder is a function called for each visited folders
   */
  async copyFolderToJson (path, visitFile, visitFolder) {
    visitFile = visitFile || (() => { })
    visitFolder = visitFolder || (() => { })
    return await this._copyFolderToJsonInternal(path, visitFile, visitFolder)
  }

  async removeFile (path) {
    path = this.removePrefix(path)
    if (await window.remixFileSystem.exists(path) && !(await window.remixFileSystem.stat(path)).isDirectory()) {
      await window.remixFileSystem.unlink(path)
      this.event.emit('fileRemoved', this._normalizePath(path))
      return true
    } else return false
  }

  async rename (oldPath, newPath, isFolder) {
    var unprefixedoldPath = this.removePrefix(oldPath)
    var unprefixednewPath = this.removePrefix(newPath)
    if (await this._exists(unprefixedoldPath)) {
      await window.remixFileSystem.rename(unprefixedoldPath, unprefixednewPath)
      this.event.emit('fileRenamed',
        this._normalizePath(unprefixedoldPath),
        this._normalizePath(unprefixednewPath),
        isFolder
      )
      return true
    }
    return false
  }

  async resolveDirectory (path, cb) {
    path = this.removePrefix(path)
    if (path.indexOf('/') !== 0) path = '/' + path
    try {
      console.log('res dir', path)
      const files = await window.remixFileSystem.readdir(path)
      const ret = {}
      console.log(files)
      if (files) {
        for (let element of files) {
          path = path.replace(/^\/|\/$/g, '') // remove first and last slash
          element = element.replace(/^\/|\/$/g, '') // remove first and last slash
          const absPath = (path === '/' ? '' : path) + '/' + element
          console.log("stat ", absPath, await window.remixFileSystem.stat(absPath))
          ret[absPath.indexOf('/') === 0 ? absPath.substr(1, absPath.length) : absPath] = { isDirectory: (await window.remixFileSystem.stat(absPath)).isDirectory() }
          // ^ ret does not accept path starting with '/'
        }
      }
      console.log("return", ret)
      if (cb) cb(null, ret)
      return ret
    } catch (error) {
      if (cb) cb(error, null)
    }
  }

  removePrefix (path) {
    path = path.indexOf(this.type) === 0 ? path.replace(this.type, '') : path
    if (path === '') return '/'
    return path
  }

  _normalizePath (path) {
    return this.type + path
  }
}

module.exports = FileProvider
