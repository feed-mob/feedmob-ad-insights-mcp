import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://admin:tpBBr4qsmAjBQ6ib6YJ1KE7F4@18.209.12.168:27017/feedmob_db?authSource=admin';

let client = null;
let db = null;
let records = null;

export async function connect() {
  if (client) return;
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('feedmob_db');
  records = db.collection('records');
}

export function disconnect() {
  if (client) {
    client.close();
    client = null;
    db = null;
    records = null;
  }
}

export function getCollection() {
  return records;
}
