import * as pako from "pako";
import * as afile from "../abstract/file.js";
import * as scran from "scran.js";
import * as utils from "./general.js";

export function extractHDF5Strings(handle, name) {
    if (!(name in handle.children)) {
        return null;
    }

    if (handle.children[name] !== "DataSet") {
        return null;
    }

    let content = handle.open(name);
    if (content.type !== "String") {
        return null;
    }

    return content.load();
}

export function readTextLines(buffer, compression = "gz") {
    let txt = buffer;
    if (compression == "gz") {
        txt = pako.ungzip(buffer);
    }

    const dec = new TextDecoder();
    let decoded = dec.decode(txt);

    let lines = decoded.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] == "") { // ignoring the trailing newline.
        lines.pop();
    }

    return lines;    
}

export function readDSVFromBuffer(content, fname, delim = "\t") {
    var ext = fname.name.split('.').pop();
    let lines = readTextLines(content, ext);
    lines.forEach((x, i) => {
        lines[i] = x.split(delim);
    });
    return lines;
}

var cache = {
    file2link: null, 
    link2file: null
};

/**
 * Specify a function to create links for data files.
 * By default, this only affects files for the MatrixMarket, H5AD and 10X formats, and is only used when linking is requested.
 *
 * @param {function} fun - Function that returns a linking idenfier to a data file.
 * The function should accept the following arguments:
 *
 * - A string specifying the type of the file, e.g., `"mtx"`, `"h5"`.
 * - A string containing the name of the file.
 * - An ArrayBuffer containing the file content (for browsers) or a string containing the file path (for Node.js),
 *
 * The function is expected to return a string containing some unique identifier to the file.
 * This is most typically used to register the file with some user-specified database system for later retrieval.
 *
 * @return `fun` is set as the global link creator for this step. 
 * The _previous_ value of the creator is returned.
 */
export function setCreateLink(fun) {
    let previous = cache.file2link;
    cache.file2link = fun;
    return previous;
}

/**
 * Specify a function to resolve links for data files.
 * By default, this only affects files for the MatrixMarket, H5AD and 10X formats, and is only used when links are detected.
 *
 * @param {function} fun - Function that accepts a string containing a linking idenfier and returns an ArrayBuffer containing the file content (for browsers) or a string containing the file path (for Node.js),
 * This is most typically used to retrieve a file from some user-specified database system.
 *
 * @return `fun` is set as the global resolver for this step. 
 * The _previous_ value of the resolver is returned.
 */
export function setResolveLink(fun) {
    let previous = cache.link2file;
    cache.link2file = fun;
    return previous;
}

export async function standardSerialize(details, type, embeddedSaver) {
    let output = { 
        "type": type,
        "name": details.name 
    };
    let serialized = details.content.serialized();

    if (embeddedSaver !== null) {
        let eout = await embeddedSaver(serialized, details.content.size());
        output.offset = eout.offset;
        output.size = eout.size;
    } else {
        let fun = cache.file2link;
        if (fun === null) {
            throw new Error("link-creating function has not been set by 'setCreateLink'");
        }
        output.id = await fun(type, details.name, serialized);
    }

    return output;
}

export async function standardUnserialize(details, embeddedLoader) {
    let output = { name: details.name };

    if ("id" in details) {
        let fun = cache.link2file;
        if (fun === null) {
            throw new Error("link-resolving function has not been set by 'setResolveLink'");
        }
        output.content = new afile.LoadedFile(await fun(details.id));
    } else {
        output.content = new afile.LoadedFile(await embeddedLoader(details.offset, details.size));
    }

    return output;
}

export function formatFile(file, sizeOnly) {
    let output = { "name": afile.rawName(file) };
    if (sizeOnly) {
        output.size = afile.rawSize(file);
    } else {
        output.content = new afile.LoadedFile(file);
    }
    return output;
}

export function subsetToGenes(output) {
    // Checking if 'type' is available, and if so, subsetting the
    // matrix to only "Gene Expression". This is a stop-gap solution
    // for dealing with non-gene features in 10X Genomics outputs.
    if (output.genes === null || !("type" in output.genes)) {
        return;
    }

    let keep = [];
    let sub = new Uint8Array(output.genes.type.length);
    let others = {};

    output.genes.type.forEach((x, i) => {
        let is_gene = x.match(/gene expression/i);
        sub[i] = is_gene; 

        if (is_gene) {
            keep.push(i);
        } else {
            if (!(x in others)) {
                others[x] = [];
            }
            others[x].push(i);
        }
    });

    // If nothing matches to 'Gene expression', then clearly it wasn't
    // very reasonable to subset on it, so we'll just give up.
    if (keep.length == 0) {
        return;
    }

    let subsetted;
    try {
        subsetted = scran.subsetRows(output.matrix, keep);

        // Does anything match 'Antibody capture'? Let's treat this a bit
        // differently by throwing in some normalization.
        let adt_key = null;
        for (const k of Object.keys(others)) {
            if (k.match(/antibody capture/i)) {
                adt_key = k;
            }
        }

        if (adt_key !== null) {
            if (output.annotations === null) {
                output.annotations = {};
            }

            let partial, norm, pcs, clust, sf, norm2;
            try {
                // Computing some decent size factors for the ADT subset. 
                partial = scran.subsetRows(output.matrix, others[adt_key]);
                norm = scran.logNormCounts(partial);
                pcs = scran.runPCA(norm, { numberOfPCs: Math.min(norm.numberOfRows() - 1, 25) });
                clust = scran.clusterKmeans(pcs, 20);
                sf = scran.groupedSizeFactors(partial, clust);
                norm2 = scran.logNormCounts(partial, { sizeFactors: sf });

                // And then storing them in the annotations.
                for (const [i, j] of Object.entries(others[adt_key])) {
                    output.annotations[adt_key + ": " + output.genes.id[j]] = norm2.row(i);
                }
            } finally {
                utils.freeCache(partial);
                utils.freeCache(norm);
                utils.freeCache(pcs);
                utils.freeCache(clust);
                utils.freeCache(sf);
                utils.freeCache(norm2);
            }
        }
        
    } catch (e) {
        utils.freeCache(subsetted);
        throw e;
    } finally {
        utils.freeCache(output.matrix); // releasing it as we will be replacing it with 'subsetted'.
    }

    output.matrix = subsetted;
    return;
}
