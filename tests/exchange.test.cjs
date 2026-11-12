const { test } = require("node:test");
const assert = require("node:assert/strict");
const { stableNumber, itemShape, findItemRequest } = require("../electron/exchange.cjs");

test("Exchange item identifiers map to stable positive local numbers", () => {
  const id = "AAMkAGI2TAAA=";
  assert.equal(stableNumber(id), stableNumber(id));
  assert.ok(Number.isSafeInteger(stableNumber(id)));
  assert.ok(stableNumber(id) > 0);
  assert.notEqual(stableNumber(id), stableNumber("AAMkAGI2TAAAB="));
});

test("Exchange FindItem uses the EWS FieldOrder schema and correct message fields", () => {
  const shape = itemShape();
  const request = findItemRequest({ ewsId: "folder-1", changeKey: "ignored" }, 0, 300, shape);
  assert.match(shape, /FieldURI="message:InternetMessageId"/);
  assert.doesNotMatch(shape, /FieldURI="item:InternetMessageId"/);
  assert.match(request, /<t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived" \/><\/t:FieldOrder>/);
  assert.match(request, /<t:FolderId Id="folder-1" \/>/);
  assert.doesNotMatch(request, /FieldOrder[^>]+FieldURI=/);
});
