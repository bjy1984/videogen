import { MongoClient, type Collection } from "mongodb";

export interface WorkbenchLibraryState {
  projectId: string;
  clips: unknown[];
  images: unknown[];
  updatedAt: string;
}

interface WorkbenchLibraryDocument extends WorkbenchLibraryState {
  _id: string;
  createdAt: string;
}

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const mongoDbName = process.env.MONGODB_DB || "videogen";
const collectionName = "workbench_library_states";
const pricingCollectionName = "seedance_model_pricing";

let clientPromise: Promise<MongoClient> | undefined;

function getClient() {
  if (!clientPromise) {
    const client = new MongoClient(mongoUri);
    clientPromise = client.connect();
  }
  return clientPromise;
}

async function getCollection(): Promise<Collection<WorkbenchLibraryDocument>> {
  const client = await getClient();
  return client.db(mongoDbName).collection<WorkbenchLibraryDocument>(collectionName);
}

export async function loadWorkbenchLibraryState(projectId: string): Promise<WorkbenchLibraryState | null> {
  const collection = await getCollection();
  const document = await collection.findOne({ _id: projectId });
  if (!document) return null;
  return {
    projectId: document.projectId,
    clips: document.clips || [],
    images: document.images || [],
    updatedAt: document.updatedAt
  };
}

export async function saveWorkbenchLibraryState(input: {
  projectId: string;
  clips: unknown[];
  images: unknown[];
}): Promise<WorkbenchLibraryState> {
  const collection = await getCollection();
  const now = new Date().toISOString();
  await collection.updateOne(
    { _id: input.projectId },
    {
      $set: {
        projectId: input.projectId,
        clips: input.clips,
        images: input.images,
        updatedAt: now
      },
      $setOnInsert: {
        _id: input.projectId,
        createdAt: now
      }
    },
    { upsert: true }
  );
  return {
    projectId: input.projectId,
    clips: input.clips,
    images: input.images,
    updatedAt: now
  };
}

export async function seedSeedanceModelPricing(pricing: Array<Record<string, unknown>>) {
  const client = await getClient();
  const collection = client.db(mongoDbName).collection(pricingCollectionName);
  const now = new Date().toISOString();
  await Promise.all(
    pricing.map((item) =>
      collection.updateOne(
        {
          model: item.model,
          resolution: item.resolution
        },
        {
          $set: {
            ...item,
            currency: "CNY",
            unit: "second",
            updatedAt: now
          },
          $setOnInsert: {
            createdAt: now
          }
        },
        { upsert: true }
      )
    )
  );
}
