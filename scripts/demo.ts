import "https://deno.land/x/dotenv/load.ts";
// import { devnetConnection, Connection, Ed25519Keypair, JsonRpcProvider, RawSigner } from '@mysten/sui.js';
import { getFullnodeUrl, SuiClient } from '@mysten/sui.js/client';


// const connection = new Connection({
//    fullnode: Deno.env.SUI_RPC_URL!,
//    faucet: Deno.env.FAUCET_URL,
// });
// // const connection = devnetConnection;
// // const connection = localnetConnection;
// const provider = new JsonRpcProvider(connection);
// const keypairseed = Deno.env.KEY_PAIR_SEED!;
// // seed 32 bytes, private key 64 bytes
// const keypair = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(keypairseed!, 'hex')));
// const signer = new RawSigner(keypair, provider);

// async function publish(packagePath: string, signer: RawSigner): Promise<SuiTransactionBlockResponse> {
//    const compiledModulesAndDeps = JSON.parse(
//      execSync(`sui move build --dump-bytecode-as-base64 --path ${packagePath}`, {
//         encoding: 'utf-8',
//      }),
//    );
//    const tx = new TransactionBlock();
//    const [upgradeCap] = tx.publish({
//       modules: compiledModulesAndDeps.modules.map((m: any) => Array.from(fromB64(m))),
//       dependencies: compiledModulesAndDeps.dependencies.map((addr: string) => normalizeSuiObjectId(addr)),
//    });
//    tx.transferObjects([upgradeCap], tx.pure(await signer.getAddress()));
//    const publishTxn = await signer.signAndExecuteTransactionBlock({
//       transactionBlock: tx,
//       options: {
//          showInput: true,
//          showEffects: true,
//          showEvents: true,
//          showObjectChanges: true,
//       },
//    });
//    console.log('publishTxn', JSON.stringify(publishTxn, null, 2));
//    return publishTxn;
// }
//
// async function sendTx(tx: TransactionBlock, signer: RawSigner): Promise<SuiTransactionBlockResponse> {
//    const txnRes = await signer.signAndExecuteTransactionBlock({
//       transactionBlock: tx,
//       options: {
//          showInput: true,
//          showEffects: true,
//          showEvents: true,
//          showObjectChanges: true,
//       },
//    });
//    // console.log('txnRes', JSON.stringify(txnRes, null, 2));
//    return txnRes;
// }

async function main() {
   console.log('social coin demo')
   // const addr = await signer.getAddress();
   // console.log(`address: ${addr}`);
}

await main();
