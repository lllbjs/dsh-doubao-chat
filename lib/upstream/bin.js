#!/usr/bin/env node
import { main } from "./cli-probe.js";
//#region src/bin.ts
/**
* `dsh-connect-doubao` — thin alias that forwards to the smoke probe so both
* the plugin bin name and the probe bin name behave identically.
*/
main().then((code) => {
	process.exitCode = code;
}, (error) => {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
});
//#endregion
export {};
