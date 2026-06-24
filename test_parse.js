const id = "stockpf_1234567890_1";
const parts = id.split('_');
const targetPage = parseInt(parts[2]) || 0;
console.log(parts);
console.log(targetPage);
