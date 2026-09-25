import { contextBridge, ipcRenderer } from 'electron';
import { channels, type DesktopAPI } from '../shared/api.js';
const api: DesktopAPI = {
  editFunction: command => ipcRenderer.invoke(channels.editFunction, command),
  search: query => ipcRenderer.invoke(channels.search, query),
  exportWorkspace: request => ipcRenderer.invoke(channels.exportWorkspace, request),
  changeHierarchy: command => ipcRenderer.invoke(channels.changeHierarchy, command),
  state: () => ipcRenderer.invoke(channels.state),
  createProject: (name, prefix) => ipcRenderer.invoke(channels.createProject, name, prefix),
  openProject: () => ipcRenderer.invoke(channels.openProject),
  openRecent: index => ipcRenderer.invoke(channels.openRecent, index),
  saveProject: () => ipcRenderer.invoke(channels.saveProject),
  updateProject: config => ipcRenderer.invoke(channels.updateProject, config),
  saveSettings: general => ipcRenderer.invoke(channels.saveSettings, general),
};
contextBridge.exposeInMainWorld('hlr', api);
