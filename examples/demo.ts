import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { getFullnodeUrl, SuiClient, SuiTransactionBlockResponse } from '@mysten/sui.js/client';
import { getFaucetHost, requestSuiFromFaucetV0 } from '@mysten/sui.js/faucet';
import { bcs } from '@mysten/bcs';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { execSync } from 'child_process';
import path from 'path';
require('dotenv').config();

const admin = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(process.env.KEY_PAIR_SEED!, 'hex')));
const user = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(process.env.USER_KEY_PAIR_SEED!, 'hex')));
const client = new SuiClient({
  url: process.env.SUI_RPC_URL!,
});
const coinType = '0x2::sui::SUI';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function publish(packagePath: string, signer: Ed25519Keypair): Promise<SuiTransactionBlockResponse> {
  const { modules, dependencies } = JSON.parse(
    execSync(`sui move build --dump-bytecode-as-base64 --path ${packagePath}`, {
      encoding: 'utf-8',
    }),
  );
  const tx = new TransactionBlock();
  const [upgradeCap] = tx.publish({
    modules,
    dependencies,
  });
  tx.transferObjects([upgradeCap], signer.toSuiAddress());
  const publishTxn = await client.signAndExecuteTransactionBlock({
    signer,
    transactionBlock: tx,
    options: {
      showInput: true,
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });
  console.log('publishTxn', JSON.stringify(publishTxn, null, 2));
  return publishTxn;
}

async function sendTx(tx: TransactionBlock, signer: Ed25519Keypair): Promise<SuiTransactionBlockResponse> {
  const txnRes = await client.signAndExecuteTransactionBlock({
    transactionBlock: tx,
    signer,
    options: {
      showInput: true,
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });
  // console.log('txnRes', JSON.stringify(txnRes, null, 2));
  if (txnRes.effects?.status.status !== 'success') {
    console.log('txnRes', JSON.stringify(txnRes, null, 2));
    throw new Error(`transaction failed with error: ${txnRes.effects?.status.error}}`);
  }
  return txnRes;
}

async function prepareAmount(
  coinType: string,
  amount: bigint,
  sender: Ed25519Keypair,
): Promise<{ tx: TransactionBlock; txCoin: any }> {
  const senderAddr = sender.toSuiAddress();
  const isNative = coinType === '0x2::sui::SUI';
  let tx = new TransactionBlock();
  if (isNative) {
    const [txCoin] = tx.splitCoins(tx.gas, [tx.pure(amount)]);
    return { tx, txCoin };
  }
  const { success, coins, totalAmount } = await getCoinsByAmount(senderAddr, coinType, amount);
  console.log({ success, coins, totalAmount });
  if (!success) {
    throw new Error(`not enough ${coinType}`);
  }
  let coin = tx.object(coins[0]);
  if (coins.length > 1) {
    tx.mergeCoins(
      coin,
      coins.slice(1).map((c) => tx.object(c)),
    );
  }
  const [txCoin] = tx.splitCoins(coin, [tx.pure(amount.toString())]);
  return { tx, txCoin };
}

// get coins whose value sum is greater than or equal to amount
async function getCoinsByAmount(
  owner: string,
  coinType: string,
  amount: bigint,
): Promise<{ success: boolean; coins: string[]; totalAmount: bigint }> {
  if (amount <= 0n) {
    throw new Error('amount must be greater than 0');
  }
  let coins: string[] = [];
  let totalAmount = 0n;
  let cursor: string | null = null;
  while (true) {
    let res = await client.getCoins({
      owner,
      coinType,
      cursor,
    });
    for (const coin of res.data) {
      coins.push(coin.coinObjectId);
      totalAmount += BigInt(coin.balance);
      if (totalAmount >= amount) {
        return { success: true, coins, totalAmount };
      }
    }
    if (!res.hasNextPage) {
      return { success: false, coins, totalAmount };
    }
  }
}

interface AppMeta {
  packageId: string;
  globalId: string;
  adminCapId?: string;
}

let tx = new TransactionBlock();

async function publishSocialCoin(signer: Ed25519Keypair): Promise<AppMeta> {
  const publishTxn = await publish(path.join(__dirname, '.'), signer);
  const packageId = (publishTxn.objectChanges!.filter((o) => o.type === 'published')[0] as any).packageId;
  const globalId = (
    publishTxn.objectChanges!.filter(
      (o) => o.type === 'created' && o.objectType.endsWith('::socialcoin::Global'),
    )[0] as any
  ).objectId;
  const adminCapId = (
    publishTxn.objectChanges!.filter(
      (o) => o.type === 'created' && o.objectType.endsWith('::socialcoin::AdminCap'),
    )[0] as any
  ).objectId;
  return {
    packageId,
    globalId,
    adminCapId,
  };
}

interface SocialCoinConfig {
  packageId: string;
  globalId: string;
  adminCapId?: string;
}

class SocialCoin {
  readonly packageId: string;
  readonly globalId: string;
  readonly adminCapId?: string;
  readonly client: SuiClient;

  sharesTableId: string | null = null;

  constructor(config: SocialCoinConfig, client: SuiClient) {
    this.packageId = config.packageId;
    this.globalId = config.globalId;
    this.adminCapId = config.adminCapId;
    this.client = client;
  }

  async getBuyPriceAfterFee(subject: string, amount: bigint, trader: string): Promise<bigint> {
    tx = new TransactionBlock();
    tx.moveCall({
      target: `${this.packageId}::socialcoin::get_buy_price_after_fee`,
      arguments: [tx.object(this.globalId), tx.pure(subject), tx.pure(amount)],
    });
    const devRes = await this.client.devInspectTransactionBlock({
      sender: trader,
      transactionBlock: tx,
    });
    // console.log('getBuyPrice', JSON.stringify(devRes, null, 2));
    const result = bcs.u64().parse(Uint8Array.from((devRes as any).results[0].returnValues[0][0]));
    return BigInt(result);
  }

  async getGlobalObject() {
    const global = await client.getObject({
      id: this.globalId,
      options: {
        showContent: true,
      },
    });
    // console.log('global', JSON.stringify(global, null, 2));
    return global;
  }

  async getSharesTableId(): Promise<string> {
    if (this.sharesTableId) {
      return this.sharesTableId;
    }
    const global = await this.getGlobalObject();
    this.sharesTableId = (global.data!.content as any).fields.shares.fields.id.id;
    return this.sharesTableId!;
  }

  async profile(subject: string) {
    const sharesTableId = await this.getSharesTableId();
    const shares = await this.client.getDynamicFieldObject({
      parentId: sharesTableId,
      name: {
        type: 'address',
        value: subject,
      },
    });
    // console.log('shares', JSON.stringify(shares, null, 2));
    const data = (shares.data!.content as any).fields.value.fields;
    const profileData = {
      supply: parseInt(data.supply),
      holdingNum: parseInt(data.holding.fields.size),
      holdingTableId: data.holding.fields.id.id,
      holderNum: parseInt(data.holders.fields.size),
      holderTableId: data.holders.fields.id.id,
    };
    return profileData;
  }

  async getHolders(subject: string, cursor: string | null, limit: number | null) {
    const profileData = await this.profile(subject);
    const holders = await this.client.getDynamicFields({
      parentId: profileData.holderTableId,
      cursor,
      limit,
    });
    console.log('holders', JSON.stringify(holders, null, 2));
    return holders;
  }

  async getHolding(subject: string, cursor: string | null, limit: number | null) {
    const profileData = await this.profile(subject);
    const holding = await this.client.getDynamicFields({
      parentId: profileData.holdingTableId,
      cursor,
      limit,
    });
    console.log('holding', JSON.stringify(holding, null, 2));
    return holding;
  }

  async buyShares(signer: Ed25519Keypair, subject: string, amount: bigint) {
    const coinAmount = await this.getBuyPriceAfterFee(subject, amount, signer.toSuiAddress());
    console.log({
      coinAmount,
      balance: await this.client.getBalance({ owner: signer.toSuiAddress() }),
    });
    let prepareAmountRes = await prepareAmount(coinType, coinAmount, signer);
    tx = prepareAmountRes.tx;
    tx.moveCall({
      target: `${this.packageId}::socialcoin::buy_shares`,
      arguments: [tx.object(this.globalId), tx.pure(subject), tx.pure(amount), prepareAmountRes.txCoin],
    });
    const buyShareTxn = await sendTx(tx, signer);
    console.log('buyShareTxn', JSON.stringify(buyShareTxn, null, 2));
    return buyShareTxn;
  }

  async sellShares(signer: Ed25519Keypair, subject: string, amount: bigint) {
    let tx = new TransactionBlock();
    tx.moveCall({
      target: `${this.packageId}::socialcoin::sell_shares`,
      arguments: [tx.object(this.globalId), tx.pure(subject), tx.pure(amount)],
    });
    const sellShareTxn = await sendTx(tx, signer);
    console.log('sellShareTxn', JSON.stringify(sellShareTxn, null, 2));
    return sellShareTxn;
  }
}

async function interact(appMeta: AppMeta, signer: Ed25519Keypair, user: Ed25519Keypair) {
  // signer buy signer's first coin
  const socialCoin = new SocialCoin(appMeta, client);
  await socialCoin.buyShares(signer, signer.toSuiAddress(), 1n);
  await socialCoin.buyShares(signer, signer.toSuiAddress(), 1n);
  // user buy signer's coin
  await socialCoin.buyShares(user, signer.toSuiAddress(), 1n);
  await socialCoin.buyShares(user, signer.toSuiAddress(), 1n);
  // user sell signer's coin
  await socialCoin.sellShares(user, signer.toSuiAddress(), 1n);
}

async function queries(appMeta: AppMeta) {
  const socialCoin = new SocialCoin(appMeta, client);
  const adminProfile = await socialCoin.profile(admin.toSuiAddress());
  console.log('adminProfile', JSON.stringify(adminProfile, null, 2));

  const adminHolders = await socialCoin.getHolders(admin.toSuiAddress(), null, null);
  console.log('admin holders', JSON.stringify(adminHolders, null, 2));

  const adminHolding = await socialCoin.getHolding(admin.toSuiAddress(), null, null);
  console.log('admin holding', JSON.stringify(adminHolding, null, 2));

  const buyPrice = await socialCoin.getBuyPriceAfterFee(admin.toSuiAddress(), 1n, admin.toSuiAddress());
  console.log('buyPrice', buyPrice);
}

async function main() {
  console.log('-----start-----');
  const addr = admin.toSuiAddress();
  console.log(`admin address: ${addr}`);
  console.log(`user address: ${user.toSuiAddress()}`);
  // faucet
  if (process.env.REQUEST_SUI) {
    await requestSuiFromFaucetV0({
      host: process.env.FAUCET_URL!,
      recipient: addr,
    });
    await requestSuiFromFaucetV0({
      host: process.env.FAUCET_URL!,
      recipient: user.toSuiAddress(),
    });
  }

  // get balance
  const balance = await client.getBalance({
    owner: addr,
  });
  console.log({ balance });

  // publish
  const appMeta = await publishSocialCoin(admin);
  // const appMeta = {
  //   "packageId": "0x34f1d3eee4bde2f3cd0ed121cdc36c3fd949c0abc0a9c9378d3ace2f6920137f",
  //   "globalId": "0x2f12e91d2271d5c8fd5e6afa56c6d3d377edddb11bb669930624d6d2e12f93dc",
  //   "adminCapId": "0x04ef6e4965090d41440bba2c92fafa6cc311e0e0050e9d627b829540f2e61cc5"
  // }

  console.log(`appMeta: ${JSON.stringify(appMeta, null, 2)}`);

  // txs
  await interact(appMeta, admin, user);
  await queries(appMeta);
  console.log('-----end-----');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`error: ${JSON.stringify(error, null, 2)}, ${error.stack}`);
    process.exit(1);
  });