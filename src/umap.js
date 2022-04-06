import * as scran from "scran.js";
import * as vizutils from "./utils/viz_parent.js";
import * as utils from "./utils/general.js";
import * as neighbor_module from "./neighbor_index.js";

/**
 * This creates a UMAP embedding based on the neighbor index constructed at {@linkcode neighbor_index}.
 * This wraps `runUMAP` and related functions from [**scran.js**](https://github.com/jkanche/scran.js).
 * 
 * The parameters in {@linkcode runAnalysis} should be an object containing:
 *
 * - `num_neighbors`: number of neighbors to use to construct the simplicial sets.
 * - `num_epochs`: number of epochs to run the algorithm.
 * - `min_dist`: number specifying the minimum distance between points.
 * - `animate`: boolean indicating whether to process animation iterations, see {@linkcode setVisualizationAnimate} for details.
 *
 * Calling **`results()`** on the relevant state instance will return an object containing:
 *
 * - `x`: a Float64Array containing the x-coordinate for each cell.
 * - `y`: a Float64Array containing the y-coordinate for each cell.
 * - `iterations`: the number of iterations processed.
 *
 * Calling **`animate()`** on the relevant state instance will repeat the animation iterations.
 * This returns a promise that resolves on successful completion of all iterations.
 * It is assumed that {@linkcode setVisualizationAnimate} has been set appropriately.
 *
 * @namespace umap
 */

export class State {
    #index;
    #parameters;
    #cache;
    #reloaded;

    #worker;
    #worker_id;

    #ready;
    #run;

    constructor(index, parameters = null, reloaded = null) {
        if (!(index instanceof neighbor_module.State)) {
            throw new Error("'index' should be a State object from './neighbor_index.js'");
        }
        this.#index = index;

        this.#parameters = (parameters === null ? {} : parameters);
        this.#cache = { "counter": 0, "promises": {} };
        this.#reloaded = reloaded;
        this.changed = false;

        let { worker, worker_id, ready } = vizutils.createWorker(new URL("./umap.worker.js", import.meta.url), this.#cache, vizutils.scranOptions);
        this.#worker = worker;
        this.#worker_id = worker_id;
        this.#ready = ready;

        this.#run = null;
    }

    ready() {
        // It is assumed that the caller will await the ready()
        // status before calling any other methods of this instance.
        return this.#ready;
    }

    free() {
        return vizutils.killWorker(this.#worker_id);
    }

    /***************************
     ******** Compute **********
     ***************************/

    #core(num_neighbors, num_epochs, min_dist, animate, reneighbor) {
        var nn_out = null;
        if (reneighbor) {
            nn_out = vizutils.computeNeighbors(this.#index, num_neighbors);
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
        this.#run = vizutils.runWithNeighbors(this.#worker, args, nn_out, this.#cache);
        return;
    }

    compute(num_neighbors, num_epochs, min_dist, animate) {
        let same_neighbors = (!this.#index.changed && this.#parameters.num_neighbors === num_neighbors);
        if (same_neighbors && num_epochs === this.#parameters.num_epochs && min_dist === this.#parameters.min_dist) {
            this.changed = false;
            return;
        }

        // In the reloaded state, we must send the neighbor
        // information, because it hasn't ever been sent before.
        if (this.#reloaded !== null) {
            same_neighbors = false;
            this.#reloaded = null;
        }

        this.#core(num_neighbors, num_epochs, min_dist, animate, !same_neighbors);

        this.#parameters.num_neighbors = num_neighbors;
        this.#parameters.num_epochs = num_epochs;
        this.#parameters.min_dist = min_dist;
        this.#parameters.animate = animate;

        this.changed = true;
        return;
    }

    /***************************
     ******** Results **********
     ***************************/

    async #fetch_results(copy)  {
        if (this.#reloaded !== null) {
            let output = {
                x: this.#reloaded.x,
                y: this.#reloaded.y
            };

            if (copy) {
                output.x = output.x.slice();
                output.y = output.y.slice();
            }

            output.iterations = this.#parameters.num_epochs;
            return output;
        } else {
            // Vectors that we get from the worker are inherently
            // copied, so no need to do anything extra here.
            await this.#run;
            return vizutils.sendTask(this.#worker, { "cmd": "FETCH" }, this.#cache);
        }
    }

    results() {
        return this.#fetch_results(true);
    }

    /*************************
     ******** Saving *********
     *************************/

    async serialize(handle) {
        let ghandle = handle.createGroup("umap");

        {
            let phandle = ghandle.createGroup("parameters");
            phandle.writeDataSet("num_neighbors", "Int32", [], this.#parameters.num_neighbors);
            phandle.writeDataSet("num_epochs", "Int32", [], this.#parameters.num_epochs);
            phandle.writeDataSet("min_dist", "Float64", [], this.#parameters.min_dist);
            phandle.writeDataSet("animate", "Uint8", [], Number(this.#parameters.animate));
        }

        {
            let res = await this.#fetch_results(false);
            let rhandle = ghandle.createGroup("results");
            rhandle.writeDataSet("x", "Float64", null, res.x);
            rhandle.writeDataSet("y", "Float64", null, res.y);
        }

        return;
    }

    /***************************
     ******** Getters **********
     ***************************/

    animate() {
        if (this.#reloaded !== null) {
            this.#reloaded = null;

            // We need to reneighbor because we haven't sent the neighbors across yet.
            this.#core(this.#parameters.num_neighbors, this.#parameters.num_epochs, this.#parameters.min_dist, true, true);
      
            // Mimicking the response from the re-run.
            return this.#run
                .then(contents => { 
                    return {
                        "type": "umap_rerun",
                        "data": { "status": "SUCCESS" }
                    };
                });
        } else {
            return vizutils.sendTask(this.#worker, { "cmd": "RERUN" }, this.#cache);
        }
    }
}

/**************************
 ******** Loading *********
 **************************/

export function unserialize(handle, index) {
    let ghandle = handle.open("umap");

    let parameters;
    {
        let phandle = ghandle.open("parameters");
        parameters = {
            num_neighbors: phandle.open("num_neighbors", { load: true }).values[0],
            num_epochs: phandle.open("num_epochs", { load: true }).values[0],
            min_dist: phandle.open("min_dist", { load: true }).values[0],
            animate: phandle.open("animate", { load: true }).values[0] > 0
        };
    }

    let reloaded;
    {
        let rhandle = ghandle.open("results");
        reloaded = {
            x: rhandle.open("x", { load: true }).values,
            y: rhandle.open("y", { load: true }).values
        };
    }

    return {
        state: new State(index, parameters, reloaded),
        parameters: { ...parameters }
    };
}
