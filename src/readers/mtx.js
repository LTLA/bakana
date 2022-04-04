import * as scran from "scran.js";
import * as utils from "./../utils/general.js";
import * as rutils from "./../utils/reader.js";

export function formatFiles(args, sizeOnly) {
    var formatted = { "format": "MatrixMarket", "files": [] };
    formatted.files.push({ "type": "mtx", ...rutils.formatFile(args.mtx, sizeOnly) });

    if ("genes" in args) {
        formatted.files.push({ "type": "genes", ...rutils.formatFile(args.genes, sizeOnly) });
    }

    if ("annotations" in args) {
        formatted.files.push({ "type": "annotations", ...rutils.formatFile(args.annotations, sizeOnly) });
    }

    return formatted;
}

export function extractFeatures(files, { numberOfRows = null } = {}) {
    let genes = null;
    const genes_file = files.filter(x => x.type == "genes");

    if (genes_file.length == 1) {
        const gene_file = genes_file[0]
        const content = new Uint8Array(gene_file.content.buffer());

        let parsed = rutils.readDSVFromBuffer(content, gene_file);
        if (numberOfRows !== null && parsed.length !== numberOfRows) {
            throw new Error("number of matrix rows is not equal to the number of genes in '" + gene_file.name + "'");
        }

        var ids = [], symb = [];
        parsed.forEach(x => {
            ids.push(x[0]);
            symb.push(x[1]);
        });

        genes = { "id": ids, "symbol": symb };
    }

    return genes;
}

function extractAnnotations(files, { numberOfColumns = null, namesOnly = false } = {}) {
    let annotations = null;
    const annotations_file = files.filter(x => x.type == "annotations");

    if (annotations_file.length == 1) {
        const annotation_file = annotations_file[0]
        const content = new Uint8Array(annotation_file.content.buffer());
        let parsed = rutils.readDSVFromBuffer(content, annotation_file);

        // Check if a header is present or not
        let headerFlag = true;
        if (numberOfColumns !== null) {
            let diff = numberOfColumns - parsed.length;
            if (diff === 0) {
                headerFlag = false;
            } else if (diff !== -1) {
                throw "number of annotations rows is not equal to the number of cells in '" + annotation_file.name + "'";
            }
        }

        let headers;
        if (headerFlag) {
            headers = parsed.shift();
        } else {
            headers = parsed[0]; // whatever, just using the first row. Hope they're unique enough!
        }

        if (namesOnly) {
            annotations = headers;
        } else {
            annotations = {}
            headers.forEach((x, i) => {
                annotations[x] = parsed.map(y => y[i]);
            });
        }
    }

    return annotations;
}

export function loadPreflight(input) {
    return {
        genes: extractFeatures(input.files),
        annotations: extractAnnotations(input.files, { namesOnly: true })
    };
}

export function loadData(input) {
    var mtx_files = input.files.filter(x => x.type == "mtx");

    var first_mtx = mtx_files[0];
    var contents = new Uint8Array(first_mtx.content.buffer());
    var ext = first_mtx.name.split('.').pop();
    var is_compressed = (ext == "gz");

    let output = {};
    try {
        output.matrix = scran.initializeSparseMatrixFromMatrixMarketBuffer(contents, { "compressed": is_compressed });
        output.genes = extractFeatures(input.files, { numberOfRows: output.matrix.numberOfRows() });
        output.annotations = extractAnnotations(input.files, { numberOfColumns: output.matrix.numberOfColumns() });
    } catch (e) {
        utils.freeCache(output.matrix);
        throw e;
    }

    return output;
}
