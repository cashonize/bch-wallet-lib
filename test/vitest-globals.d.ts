/// <reference types="vitest/globals" />

// the globals the library keeps its providers and cached exchange rates in
declare var BCH: any;
declare var tBCH: any;
declare var rBCH: any;
declare var RATE: any;

declare module "node-localstorage" {
  export class LocalStorage {
    constructor(location: string);
  }
}
