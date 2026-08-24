import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("electronBaseline", {
  platform: process.platform
});
