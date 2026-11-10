class InspectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InspectionError';
    this.code = code;
  }
}

module.exports = { InspectionError };
