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
export function initialize(animateFun, scranOptions) {
    worker = aworkers.createWorker(new URL("./tsne.worker.js", import.meta.url));
    return vizutils.initializeWorker(worker, cache, animateFun, scranOptions);
}

export function terminate() {
    return aworkers.terminateWorker(worker);
}

/***************************
 ******** Compute **********
 ***************************/

function core(perplexity, iterations, animate, reneighbor) {
    var nn_out = null;
    if (reneighbor) {
        var k = scran.perplexityToNeighbors(perplexity);
        nn_out = vizutils.computeNeighbors(k);
    }

    let args = {
        "perplexity": perplexity,
        "iterations": iterations,
        "animate": animate
    };

    // This returns a promise but the message itself is sent synchronously,
    // which is important to ensure that the t-SNE runs in its worker in
    // parallel with other analysis steps. Do NOT put the runWithNeighbors
    // call in a .then() as this may defer the message sending until 
    // the current thread is completely done processing.
    return vizutils.runWithNeighbors(worker, args, nn_out, cache);
}

export function compute(perplexity, iterations, animate) {
    let reneighbor = (index.changed || perplexity != parameters.perplexity);

    if (reneighbor || iterations != parameters.iterations) {
        // Dealing with reloaded data; in this case, we must send the neighbor
        // information, because it hasn't ever been sent before.
        if ("reloaded" in cache) {
            reneighbor = true;
            delete cache.reloaded;
        }

        cache.run = core(perplexity, iterations, animate, reneighbor);

        parameters.perplexity = perplexity;
        parameters.iterations = iterations;
        parameters.animate = animate;

        changed = true;
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
    
        output.iterations = parameters.iterations;
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
    let ghandle = handle.createGroup("tsne");

    {
        let phandle = ghandle.createGroup("parameters");
        phandle.writeDataSet("perplexity", "Float64", [], parameters.perplexity);
        phandle.writeDataSet("iterations", "Int32", [], parameters.iterations);
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
    let ghandle = handle.open("tsne");

    {
        let phandle = ghandle.open("parameters");
        parameters = {
            perplexity: phandle.open("perplexity", { load: true }).values[0],
            iterations: phandle.open("iterations", { load: true }).values[0],
            animate: phandle.open("animate", { load: true }).values[0] > 0
        };
    }

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
        delete cache.reloaded;

        // We need to reneighbor because we haven't sent the neighbors across yet.
        core(parameters.perplexity, parameters.iterations, true, true);

        // Mimicking the response from the re-run.
        return cache.run
            .then(contents => {
                return {
                    "type": "tsne_rerun",
                    "data": { "status": "SUCCESS" }
                };
            });
    } else {
        return vizutils.sendTask(worker, { "cmd": "RERUN" }, cache);
    }
}
