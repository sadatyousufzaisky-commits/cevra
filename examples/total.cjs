function total(weights) {
  return weights.reduce((sum, weight) => sum + Math.floor(weight), 0);
}

module.exports = { total };
