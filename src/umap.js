import * as scran from "scran.js";
import * as vizutils from "./utils/viz_parent.js";
import * as index from "./neighbor_index.js";
import * as utils from "./utils/general.js";
import * as aworkers from "./abstract/worker_parent.js";

var cache = { "counter": 0, "promises": {} };
var parameters = {};
export var changed = false;

/***************************
 ******** Workers **********
 ***************************/

var worker = null;
export function initialize(scranOptions) {
    worker = aworkers.createWorker(new URL("./umap.worker.js", import.meta.url));
    return vizutils.initializeWorker(worker, cache, scranOptions);
}

export function terminate() {
    return aworkers.terminateWorker(worker);
}

/***************************
 ******** Compute **********
 ***************************/

function core(num_neighbors, num_epochs, min_dist, animate, reneighbor) {
    var nn_out = null;
    if (reneighbor) {
        nn_out = vizutils.computeNeighbors(num_neighbors);
    }

    let args = {
        "num_neighbors": num_neighbors,
        "num_epochs": num_epochs,
        "min_dist": min_dist,
        "animate": animate
    };

    // This returns a promise but the message itself is sent synchronously,
    // which is important to ensure that the UMAP runs in its worker in
    // parallel with other analysis steps. Do NOT put the runWithNeighbors
    // call in a .then() as this may defer the message sending until 
    // the current thread is completely done processing.
    cache.run = vizutils.runWithNeighbors(worker, args, nn_out, cache);
    return;
}

export function compute(num_neighbors, num_epochs, min_dist, animate) {
    let reneighbor = (index.changed || parameters.num_neighbors != num_neighbors || "reloaded" in cache);
    changed = (reneighbor || num_epochs != parameters.num_epochs || min_dist != parameters.min_dist);

    if (changed) {
        core(num_neighbors, num_epochs, min_dist, animate, reneighbor);

        parameters.num_neighbors = num_neighbors;
        parameters.num_epochs = num_epochs;
        parameters.min_dist = min_dist;
        parameters.animate = animate;

        delete cache.reloaded;
    }

    return;
}

/***************************
 ******** Results **********
 ***************************/

async function fetch_results(copy)  {
    if ("reloaded" in cache) {
        let output = {
            x: cache.reloaded.x,
            y: cache.reloaded.y
        };

        if (copy) {
            output.x = output.x.slice();
            output.y = output.y.slice();
        }

        output.iterations = parameters.num_epochs;
        return output;
    } else {
        // Vectors that we get from the worker are inherently
        // copied, so no need to do anything extra here.
        await cache.run;
        return vizutils.sendTask(worker, { "cmd": "FETCH" }, cache);
    }
}

export function results() {
    return fetch_results(true);
}

/*************************
 ******** Saving *********
 *************************/

export async function serialize(handle) {
    let ghandle = handle.createGroup("umap");

    {
        let phandle = ghandle.createGroup("parameters");
        phandle.writeDataSet("num_neighbors", "Int32", [], parameters.num_neighbors);
        phandle.writeDataSet("num_epochs", "Int32", [], parameters.num_epochs);
        phandle.writeDataSet("min_dist", "Float64", [], parameters.min_dist);
        phandle.writeDataSet("animate", "Uint8", [], Number(parameters.animate));
    }

    {
        let res = await fetch_results(false);
        let rhandle = ghandle.createGroup("results");
        rhandle.writeDataSet("x", "Float64", null, res.x);
        rhandle.writeDataSet("y", "Float64", null, res.y);
    }

    return;
}

/**************************
 ******** Loading *********
 **************************/

export function unserialize(handle) {
    let ghandle = handle.open("umap");

    {
        let phandle = ghandle.open("parameters");
        parameters = {
            num_neighbors: phandle.open("num_neighbors", { load: true }).values[0],
            num_epochs: phandle.open("num_epochs", { load: true }).values[0],
            min_dist: phandle.open("min_dist", { load: true }).values[0],
            animate: phandle.open("animate", { load: true }).values[0] > 0
        };
    }

    changed = false;

    {
        let rhandle = ghandle.open("results");
        cache.reloaded = {
            x: rhandle.open("x", { load: true }).values,
            y: rhandle.open("y", { load: true }).values
        };
    }

    return { ...parameters };
}

/***************************
 ******** Getters **********
 ***************************/

export function animate() {
    if ("reloaded" in cache) {
        // We need to reneighbor because we haven't sent the neighbors across yet.
        core(parameters.num_neighbors, parameters.num_epochs, parameters.min_dist, true, true);
  
        // Mimicking the response from the re-run.
        return cache.run
            .then(contents => { 
                return {
                    "type": "umap_rerun",
                    "data": { "status": "SUCCESS" }
                };
            });
    } else {
        return vizutils.sendTask(worker, { "cmd": "RERUN" }, cache);
    }
}
