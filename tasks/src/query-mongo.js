const { MongoClient } = require("D:/web-auto/node_modules/mongodb");
(async () => {
  const c = new MongoClient(process.env.MONGO_URI, { tls: true, tlsAllowInvalidCertificates: true });
  await c.connect();
  const coll = c.db("General").collection("BasLedger");

  // Remove footer/summary rows (no aviNr or medlem)
  const removed = await coll.deleteMany({ $or: [{ aviNr: "" }, { medlem: "" }] });
  console.log("Removed " + removed.deletedCount + " summary rows");

  const total = await coll.countDocuments();
  const totalBelopp = await coll.aggregate([{ $group: { _id: null, sum: { $sum: "$belopp" } } }]).toArray();
  const totalAterstar = await coll.aggregate([{ $group: { _id: null, sum: { $sum: "$aterstar" } } }]).toArray();

  console.log("\nCorrected totals:");
  console.log("Rows: " + total);
  console.log("Belopp: " + totalBelopp[0]?.sum.toFixed(2) + " SEK");
  console.log("Återstår: " + totalAterstar[0]?.sum.toFixed(2) + " SEK");
  await c.close();
})();
