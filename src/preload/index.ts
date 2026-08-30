import { contextBridge } from 'electron';

export interface FMBContext {
  version: string;
  platform: string;
}

declare global {
  interface Window {
    fmb: FMBContext;
  }
}

const fmb: FMBContext = {
  version: '0.1.0',
  platform: process.platform,
};

contextBridge.exposeInMainWorld('fmb', fmb);
