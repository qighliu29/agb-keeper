const R = require('ramda');

function Heap(capacity, values, compare) {
    this.contentCompare = compare || Object.compare;
    this.content = values.sort(this.contentCompare)
    this.capacity = capacity;
}

Heap.prototype.push = function (value) {
    if (this.content.length < this.capacity || this.contentCompare(this.content[this.content.length - 1], value)) {
        this.content.push(value)
        this.content = this.content.sort(this.contentCompare)
        this.content = this.content.slice(0, this.capacity);
    }
}

Heap.prototype.values = function () {
    return this.content;
}

function jaccardIndex(s1, s2) {
    return Math.round(R.intersection(s1, s2).length / R.union(s1, s2).length * 10000) / 10000;
}

exports.nearestNeighbourN = function(query, space, n) {
    let res = new Heap(n, [], (o1, o2) => o1.jac < o2.jac);
    space.forEach((v, i) => res.push({ index: i, jac: jaccardIndex(query, v) }), null);

    return res.values().map((v) => v.index);
}