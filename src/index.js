export * from "./defaults.js";
export * from "./analysis.js";
export * from "./serialize.js";

export { validateAnnotations } from "./preflight.js";
export { availableReaders } from "./readers/index.js";
export { setVisualizationAnimate } from "./steps/utils/viz_parent.js";
export { setCreateLink, setResolveLink, unpackText, readLines, readTable, promoteToNumber, summarizeArray } from "./readers/utils/index.js";
export { setCellLabellingDownload } from "./steps/cell_labelling.js";

import * as scran from "scran.js";
import * as vizutils from "./steps/utils/viz_parent.js";

/**
 * Initialize the backend for computation.
 * This is required prior to running any other **bakana** function.
 *
 * @param {object} [options] - Optional parameters.
 * @param {number} [options.numberOfThreads] - Number of threads used by **scran.js**.
 * @param {boolean} [options.localFile] - Whether to use local file paths for imported modules in **scran.js**.
 * This only needs to be `true` for old Node versions that do not support file URIs.
 * 
 * @return A promise that resolves to `null` when initialization is complete.
 */
export function initialize({ numberOfThreads = 1, localFile = false } = {}) {
    let s = scran.initialize({ 
        numberOfThreads: numberOfThreads,
        localFile: localFile
    });
    vizutils.scranOptions.localFile = localFile;
    return s.then(x => null); 
}

/**
 * Terminate the backend, in particular shutting down all workers.
 * This is typically necessary for a clean shutdown in Node.js applications.
 *
 * @return A promise that resolves to `null` when all workers are terminated.
 */
export function terminate() {
    let s = scran.terminate();
    let w = vizutils.killAllWorkers();
    return Promise.all([s, w]).then(x => null);
}

/**
 * Call a **scran.js** function.
 * This allows client applications to operate in the same **scran.js** memory space as **bakana** functions,
 * which is not guaranteed if applications import **scran.js** on their own (e.g., due to name mangling with Webpack).
 *
 * @param {function} fun - A function that accepts the **scran.js** module object and presumably calls some of its functions.
 *
 * @return The return value of `fun`.
 */
export function callScran(fun) {
    return fun(scran);
}
