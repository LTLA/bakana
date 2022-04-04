import * as scran from "scran.js";
import * as index from "./../neighbor_index.js";
import * as utils from "./general.js";
import * as aworkers from "../abstract/worker_parent.js";

export function computeNeighbors(k) {
    var nn_index = index.fetchIndex();

    var output = { "num_obs": nn_index.numberOfCells() };
    var results = null, rbuf = null, ibuf = null, dbuf = null;
    try {
        results = scran.findNearestNeighbors(nn_index, k);

        rbuf = scran.createInt32WasmArray(results.numberOfCells());
        ibuf = scran.createInt32WasmArray(results.size());
        dbuf = scran.createFloat64WasmArray(results.size());

        results.serialize({ runs: rbuf, indices: ibuf, distances: dbuf });
        output["size"] = results.size();
        output["runs"] = rbuf.array().slice();
        output["indices"] = ibuf.array().slice();
        output["distances"] = dbuf.array().slice();

    } finally {
        if (results !== null) {
            results.free();
        }
        if (rbuf !== null) {
            rbuf.free();
        }
        if (ibuf !== null) {
            ibuf.free();
        }
        if (dbuf !== null) {
            dbuf.free();
        }
    }

    return output;
}

export function sendTask(worker, payload, cache, transferrable = []) {
    var i = cache.counter;
    var p = new Promise((resolve, reject) => {
        cache.promises[i] = { "resolve": resolve, "reject": reject };
    });
    cache.counter++;
    payload.id = i;
    aworkers.sendMessage(worker, payload, transferrable);
    return p;
}

export function initializeWorker(worker, cache, animateFun, scranOptions) {
    aworkers.registerCallback(worker, msg => {
        var type = msg.data.type;
        if (type.endsWith("_iter")) {
            animateFun(msg.data.x, msg.data.y, msg.data.iteration);
            return;
        }
  
        var id = msg.data.id;
        var fun = cache.promises[id];
        if (type == "error") {
            fun.reject(msg.data.error);
        } else {
            fun.resolve(msg.data.data);
        }
        delete cache.promises[id];
    });

    return sendTask(worker, { "cmd": "INIT", scranOptions: scranOptions }, cache);
}

export function runWithNeighbors(worker, args, nn_out, cache) {
    var run_msg = {
        "cmd": "RUN",
        "params": args 
    };

    var transferrable = [];
    if (nn_out !== null) {
        transferrable = [
            nn_out.runs.buffer,
            nn_out.indices.buffer,
            nn_out.distances.buffer
        ];
        run_msg.neighbors = nn_out;
    }

    return sendTask(worker, run_msg, cache, transferrable);
}
