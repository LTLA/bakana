import * as scran from "scran.js";
import * as utils from "./utils/general.js";
import * as snn_module from "./snn_graph_cluster.js";
import * as kmeans_module from "./kmeans_cluster.js";

/**
 * This step chooses between the k-means and SNN graph clusterings.
 * We added this step to preserve the cache for each clustering step - 
 * specifically, each clustering does not need to be recomputed when a user changes their choice.
 *
 * Methods not documented here are not part of the stable API and should not be used by applications.
 * @hideconstructor
 */
export class ChooseClusteringState {
    #snn_cluster;
    #kmeans_cluster;
    #parameters;
    #cache;

    constructor(snn, kmeans, parameters = null, cache = null) {
        if (!(snn instanceof snn_module.SnnGraphClusterState)) {
            throw new Error("'snn' should be a State object from './snn_graph_cluster.js'");
        }
        this.#snn_cluster = snn;

        if (!(kmeans instanceof kmeans_module.KmeansClusterState)) {
            throw new Error("'kmeans' should be a State object from './kmeans_cluster.js'");
        }
        this.#kmeans_cluster = kmeans;

        this.#parameters = (parameters === null ? {} : parameters);
        this.#cache = (cache === null ? {} : cache);
        this.changed = false;
    }

    free() {}

    /***************************
     ******** Getters **********
     ***************************/

    fetchClustersAsWasmArray() {
        if (this.#parameters.method == "snn_graph") {
            return this.#snn_cluster.fetchClustersAsWasmArray();
        } else if (this.#parameters.method == "kmeans") {
            return this.#kmeans_cluster.fetchClustersAsWasmArray();
        }
    }

    fetchParameters() {
        return { ...this.#parameters };
    }

    /**
     * Obtain the indices of all cells belonging to the specified cluster.
     *
     * @param {number} cluster - Identifier for the cluster of interest.
     * This should be a number in the range of values defined by {@linkcode ChooseClusteringState#summary summary.clusters}.
     *
     * @return {Array} Array of indices for all cells belonging to `cluster`.
     * Note that indices are relative to the filtered matrix - 
     * use {@linkcode CellFilteringState#undoFiltering CellFilteringState.undoFiltering} to convert them to indices on the original dataset.
     */
    fetchClusterIndices(cluster) {
        let keep = [];
        this.fetchClustersAsWasmArray().forEach((x, i) => {
            if (x == cluster) {
                keep.push(i);
            }
        });
        return keep;
    }

    /***************************
     ******** Compute **********
     ***************************/

    /**
     * This method should not be called directly by users, but is instead invoked by {@linkcode runAnalysis}.
     * Each argument is taken from the property of the same name in the `choose_clustering` property of the `parameters` of {@linkcode runAnalysis}.
     *
     * @param {string} method - Either `"kmeans"` or `"snn_graph"`.
     *
     * @return The object is updated with the new results.
     */
    compute(method) {
        this.changed = true;
        
        if (method == this.#parameters.method) {
            if (method == "snn_graph") {
                if (!this.#snn_cluster.changed) {
                    this.changed = false;
                }
            } else if (method == "kmeans") {
                if (!this.#kmeans_cluster.changed) {
                    this.changed = false;
                }
            }
        }

        this.#parameters.method = method;
        return;
    }

    /***************************
     ******** Results **********
     ***************************/

    /**
     * Obtain a summary of the state, typically for display on a UI like **kana**.
     *
     * @return An object containing:
     *
     * - `clusters`: an Int32Array of length equal to the number of cells (after QC filtering),
     * containing the cluster assignment for each cell.
     */
    summary() {
        var clusters = this.fetchClustersAsWasmArray();
        return { "clusters": clusters.slice() };
    }

    /*************************
     ******** Saving *********
     *************************/

    serialize(handle) {
        let ghandle = handle.createGroup("choose_clustering");

        {
            let phandle = ghandle.createGroup("parameters");
            phandle.writeDataSet("method", "String", [], this.#parameters.method);
        }

        // No need to serialize the cluster IDs as this is done for each step.
        ghandle.createGroup("results");
        return;
    }
}

/**************************
 ******** Loading *********
 **************************/

export function unserialize(handle, snn, kmeans) {
    let ghandle = handle.open("choose_clustering");

    let parameters;
    {
        let phandle = ghandle.open("parameters");
        parameters = {
            method: phandle.open("method", { load: true }).values[0]
        };
    }

    let cache = {};
    return new ChooseClusteringState(snn, kmeans, parameters, cache);
}
