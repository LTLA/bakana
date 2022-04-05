import * as scran from "scran.js";
import * as utils from "./utils/general.js";
import * as snn_cluster from "./snn_graph_cluster.js";
import * as kmeans_cluster from "./kmeans_cluster.js";

var parameters = {};

export var changed = false;

/***************************
 ******** Compute **********
 ***************************/

export function compute(method) {
    changed = true;
    
    if (method == parameters.method) {
        if (method == "snn_graph") {
            if (!snn_cluster.changed) {
                changed = false;
            }
        } else if (method == "kmeans") {
            if (!kmeans_cluster.changed) {
                changed = false;
            }
        }
    }

    parameters.method = method;
    return;
}

/***************************
 ******** Results **********
 ***************************/

export function results() {
    var clusters = fetchClustersAsWasmArray();
    return { "clusters": clusters.slice() };
}

/*************************
 ******** Saving *********
 *************************/

export function serialize(handle) {
    let ghandle = handle.createGroup("choose_clustering");

    {
        let phandle = ghandle.createGroup("parameters");
        phandle.writeDataSet("method", "String", [], parameters.method);
    }

    // No need to serialize the cluster IDs as this is done for each step.
    ghandle.createGroup("results");
    return;
}

/**************************
 ******** Loading *********
 **************************/

export function unserialize(handle) {
    let ghandle = handle.open("choose_clustering");

    {
        let phandle = ghandle.open("parameters");
        parameters = {
            method: phandle.open("method", { load: true }).values[0]
        };
    }

    changed = false;
    return { ...parameters };
}

/***************************
 ******** Getters **********
 ***************************/

export function fetchClustersAsWasmArray() {
    if (parameters.method == "snn_graph") {
        return snn_cluster.fetchClustersAsWasmArray();
    } else if (parameters.method == "kmeans") {
        return kmeans_cluster.fetchClustersAsWasmArray();
    }
}
