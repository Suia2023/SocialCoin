import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { getFullnodeUrl, SuiClient, SuiTransactionBlockResponse } from '@mysten/sui.js/client';
import { getFaucetHost, requestSuiFromFaucetV0 } from '@mysten/sui.js/faucet';
import { BCS, getSuiMoveConfig, bcs } from '@mysten/bcs';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { execSync } from 'child_process';
import path from 'path';
import { MessageEncoder, MessageType } from './message_encoder';
require('dotenv').config();

const admin = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(process.env.KEY_PAIR_SEED!, 'hex')));
const user = Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(process.env.USER_KEY_PAIR_SEED!, 'hex')));
const client = new SuiClient({
  url: process.env.SUI_RPC_URL!,
});
const coinType = '0x2::sui::SUI';
const CLOCK_ID = '0x6';
const bcs_ser = new BCS(getSuiMoveConfig());
const messageEncoder = new MessageEncoder();

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
  clubGlobalId?: string;
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
  const clubGlobalId = (
    publishTxn.objectChanges!.filter((o) => o.type === 'created' && o.objectType.endsWith('::club::Global'))[0] as any
  ).objectId;
  return {
    packageId,
    globalId,
    adminCapId,
    clubGlobalId,
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

  async getIssuePriceAfterFee(issueAmount: bigint): Promise<bigint> {
    if (issueAmount == 0n) {
      throw new Error('issue amount must be greater than 0');
    }
    if (issueAmount == 1n) {
      return 0n;
    }
    tx = new TransactionBlock();
    tx.moveCall({
      target: `${this.packageId}::socialcoin::get_price`,
      arguments: [tx.pure(1), tx.pure(issueAmount - 1n)],
    });
    const devRes = await this.client.devInspectTransactionBlock({
      // sender: '0x729bc9d2c95162733899493e559044e6e3a88bc6e5d42177d429354d8420e6a4',
      sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
      transactionBlock: tx,
    });
    console.log('getBuyPrice', JSON.stringify(devRes, null, 2));
    const result = bcs.u64().parse(Uint8Array.from((devRes as any).results[0].returnValues[0][0]));
    const price = BigInt(result);
    console.log('price', price);
    const global = await this.getGlobalObject();
    console.log('global', JSON.stringify(global, null, 2));
    const protocol_fee_percent = (global.data!.content as any).fields.config.fields.protocol_fee_percent;
    const subject_fee_percent = (global.data!.content as any).fields.config.fields.subject_fee_percent;
    const protocol_fee = (price * BigInt(protocol_fee_percent)) / 1000000000n;
    const subject_fee = (price * BigInt(subject_fee_percent)) / 1000000000n;
    return price + protocol_fee + subject_fee;
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

  // issue social coin, can only be called by self, can determine amount of self buy
  async issue(signer: Ed25519Keypair, buyAmount: bigint) {
    const subject = signer.toSuiAddress();
    const coinAmount = await this.getIssuePriceAfterFee(buyAmount);
    const balance = await this.client.getBalance({ owner: signer.toSuiAddress() });
    console.log({
      coinAmount,
      balance,
    });
    tx = new TransactionBlock();
    if (buyAmount == 1n) {
      const [zeroCoin] = tx.splitCoins(tx.gas, [tx.pure(0)]);
      tx.moveCall({
        target: `${this.packageId}::socialcoin::buy_shares`,
        arguments: [tx.object(this.globalId), tx.pure(subject), tx.pure(1), zeroCoin],
      });
    } else if (buyAmount > 1n) {
      const [zeroCoin, issueCoin] = tx.splitCoins(tx.gas, [tx.pure(0), tx.pure(coinAmount)]);
      tx.moveCall({
        target: `${this.packageId}::socialcoin::buy_shares`,
        arguments: [tx.object(this.globalId), tx.pure(subject), tx.pure(1), zeroCoin],
      });
      tx.moveCall({
        target: `${this.packageId}::socialcoin::buy_shares`,
        arguments: [tx.object(this.globalId), tx.pure(subject), tx.pure(buyAmount - 1n), issueCoin],
      });
    } else {
      throw new Error('buyAmount must be greater than 0');
    }
    const issueTxn = await sendTx(tx, signer);
    console.log('issueTxn', JSON.stringify(issueTxn, null, 2));
    return issueTxn;
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
    // preview
    const preview = await this.client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: signer.toSuiAddress(),
    });
    console.log('preview', JSON.stringify((preview.events as any).parsedJson, null, 2));
    // example
    // {
    //   "is_buy": true,
    //   "protocol_sui_amount": "12000000",  // price without fee
    //   "share_amount": "1",
    //   "subject": "0x67a156739dda6d4ab39b0a817398190f5842168629686b91c0b9da9ae1a4aecb",
    //   "subject_sui_amount": "8000000",
    //   "sui_amount": "400000000",
    //   "supply": "3",  // supply after buy
    //   "trader": "0x1e37a9b8a30dabf1071aa7139f5b1385f3ccb62f1617c71db5204259d329a028"
    // }
    // send
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
  await socialCoin.issue(signer, 1n);
  await socialCoin.issue(user, 3n);
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

async function interactWithClub(appMeta: AppMeta, subject: Ed25519Keypair, user: Ed25519Keypair) {
  const subjectAddr = subject.toSuiAddress();
  const userAddr = user.toSuiAddress();
  // new message
  let rawMsg = 'suia to da moon';
  let msg = messageEncoder.encode(rawMsg, MessageType.XOR);
  const msgParam = bcs_ser.ser('vector<u8>', msg).toBytes();
  console.log(`raw message: ${rawMsg}, encoded message: ${msg}`);
  let tx = new TransactionBlock();
  for (let i = 0; i < 10; i++) {
    tx.moveCall({
      target: `${appMeta.packageId}::club::new_message`,
      arguments: [
        tx.object(CLOCK_ID),
        tx.object(appMeta.globalId),
        tx.object(appMeta.clubGlobalId!),
        tx.pure(subjectAddr),
        tx.pure(msgParam),
      ],
    });
  }
  const newMessageTxn = await sendTx(tx, user);
  console.log('newMessageTxn', JSON.stringify(newMessageTxn, null, 2));

  // get messages
  const clubObj = await client.getObject({
    id: appMeta.clubGlobalId!,
    options: {
      showContent: true,
    },
  });
  console.log('clubObj', JSON.stringify(clubObj, null, 2));
  // this param is not changed after it is created, can be cached in front end
  const clubsTableId = (clubObj.data!.content as any).fields.clubs.fields.id.id;
  // get club object of subject
  await sleep(3000);
  const subjectClubObj = await client.getDynamicFieldObject({
    parentId: clubsTableId,
    name: {
      type: 'address',
      value: subjectAddr,
    },
  });
  console.log('subjectClubObj', JSON.stringify(subjectClubObj, null, 2));
  const clubMsgSize = parseInt(
    (subjectClubObj.data!.content as any).fields.value.fields.messages.fields.contents.fields.size,
  );
  const clubMsgTableId = (subjectClubObj.data!.content as any).fields.value.fields.messages.fields.contents.fields.id
    .id;
  console.log('clubMsgSize', clubMsgSize);
  // this is also not changed after it is created, can be cached in front end
  // by mapping (tokenOwner => clubMsgTableId)
  console.log('clubMsgTableId', clubMsgTableId);
  console.log(`first message: ${JSON.stringify(await getMsg(clubMsgTableId, 0), null, 2)}`);
  const latestMsgs = await getMsgs(clubMsgTableId, clubMsgSize - 5, 5);
  console.log('latest5Msgs', JSON.stringify(latestMsgs, null, 2));

  // delete the first message
  tx = new TransactionBlock();
  tx.moveCall({
    target: `${appMeta.packageId}::club::delete_message`,
    arguments: [tx.object(appMeta.clubGlobalId!), tx.pure(subjectAddr), tx.pure(0)],
  });
  const deleteMessageTxn = await sendTx(tx, user);
  console.log('deleteMessageTxn', JSON.stringify(deleteMessageTxn, null, 2));
  // check effect
  console.log(`first message: ${JSON.stringify(await getMsg(clubMsgTableId, 0), null, 2)}`);
}

interface ClubMsg {
  content: string;
  sender: string;
  timestamp: number;
  deleted: boolean;
}

async function getMsg(clubMsgTableId: string, index: number): Promise<ClubMsg> {
  const msg = await client.getDynamicFieldObject({
    parentId: clubMsgTableId,
    name: {
      type: 'u64',
      value: index.toString(),
    },
  });
  // console.log('msg', JSON.stringify(msg, null, 2));
  const content = (msg.data!.content as any).fields.value.fields;
  const clubMsg = {
    content: '',
    sender: content.sender,
    timestamp: parseInt(content.timestamp),
    deleted: content.deleted,
  };
  if (!clubMsg.deleted) {
    clubMsg.content = messageEncoder.decode(Uint8Array.from(content.content));
  }
  return clubMsg;
}

async function getMsgs(clubMsgTableId: string, offset: number, limit: number): Promise<ClubMsg[]> {
  const futures = [];
  for (let i = offset; i < offset + limit; i++) {
    futures.push(getMsg(clubMsgTableId, i));
  }
  const msgs = await Promise.all(futures);
  return msgs;
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
  //   "packageId": "0x09c24ff60b8b83e058f6bc8feb5a4ad26436645f8c5582b49a487cfa540e84f0",
  //   "globalId": "0xcc50dc2e2c30f3dbc0d7637d96c7ffd5c7834c66a3207ab157b790eef27d7976",
  //   "adminCapId": "0x5ce7230a740f6ed4b86a599945d8a16ec7794fd99f5f1b5b49e9cd391eeb4cef",
  //   "clubGlobalId": "0x9afc0130704eeca0efd03b6a08886b54752d1d2fcbf7f623c6ead0e46d820956",
  // }

  console.log(`appMeta: ${JSON.stringify(appMeta, null, 2)}`);

  // social coin txs
  await interact(appMeta, admin, user);
  await queries(appMeta);

  // club txs
  await interactWithClub(appMeta, admin, user);
  console.log('-----end-----');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`error: ${JSON.stringify(error, null, 2)}, ${error.stack}`);
    process.exit(1);
  });
