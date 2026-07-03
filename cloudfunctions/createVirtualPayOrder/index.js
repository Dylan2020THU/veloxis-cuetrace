const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const crypto = require('crypto');
const https = require('https');

const db = cloud.database();
const fulfill = require('./lib/fulfill');

// ===== 配置（密钥类务必走云函数环境变量，勿硬编码/入 git）=====
const OFFER_ID = process.env.VIRTUAL_PAY_OFFER_ID || '1450563395';     // 支付应用ID（后台基本配置）
const WX_APPID = process.env.WX_APPID || 'wxa7c9920cda26d7ca';          // 小程序 AppID
const WX_APPSECRET = process.env.WX_APPSECRET || '';                   // 小程序密钥（开发设置）→ code2Session 用
const APPKEY_PROD = process.env.VIRTUAL_PAY_APPKEY || '';              // 现网 AppKey
const APPKEY_SANDBOX = process.env.VIRTUAL_PAY_APPKEY_SANDBOX || '';   // 沙箱 AppKey
const PAY_ENV = String(process.env.VIRTUAL_PAY_ENV || '0') === '1' ? 1 : 0; // 0=现网 1=沙箱（iOS 不支持沙箱）
const APPKEY = PAY_ENV === 1 ? APPKEY_SANDBOX : APPKEY_PROD;            // 按当前环境选用的 AppKey
// 道具映射：道具配置里为每个 套餐_周期 建一个道具，道具ID 约定为 `${planKey}_${period}`；
// 若后台道具ID不同，用环境变量 VIRTUAL_PAY_PRODUCTS 覆盖（JSON：{"shop_lite_year":"<productId>",...}）。
let PRODUCT_MAP = {};
try { PRODUCT_MAP = JSON.parse(process.env.VIRTUAL_PAY_PRODUCTS || '{}'); } catch (e) { PRODUCT_MAP = {}; }

function code2Session(code) {
  const url = 'https://api.weixin.qq.com/sns/jscode2session?appid=' + WX_APPID +
    '&secret=' + WX_APPSECRET + '&js_code=' + code + '&grant_type=authorization_code';
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// outTradeNo：≤32 位，仅 [0-9A-Za-z_-]；时间 + openid 尾 + 随机
function genOutTradeNo(openid) {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  const ts = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  const tail = String(openid || '').slice(-6).replace(/[^0-9A-Za-z]/g, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return ('CT' + ts + tail + rand).slice(0, 32);
}

// 服务端下单 + 签名，返回 wx.requestVirtualPayment 所需参数。
// 入参：planKey, role, period, code（client wx.login 的 code，用于换 session_key 做用户态签名）
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  // 配置自检：密钥必须由云函数环境变量注入，缺失即安全失败
  if (!WX_APPSECRET || !APPKEY) {
    console.error('[createVirtualPayOrder] secret env missing', { hasAppSecret: !!WX_APPSECRET, hasAppKey: !!APPKEY, env: PAY_ENV });
    return { ok: false, code: 'CONFIG_MISSING', msg: '支付未配置，请联系管理员' };
  }
  const planKey = String(event.planKey || '');
  const role = fulfill.normRole(event.role);
  const period = fulfill.normPeriod(event.period);
  const paymentMode = 'one_time';
  const code = String(event.code || '');
  if (!code) return { ok: false, code: 'NO_CODE', msg: '缺少登录票据' };

  // 1) 取用户与当前订阅
  const users = db.collection('users');
  const found = await users.where({ _openid: OPENID }).get();
  if (!found.data.length) return { ok: false, code: 'USER_NOT_FOUND', msg: '请先登录' };
  const user = found.data[0];
  const perRole = (user.per_role && typeof user.per_role === 'object') ? user.per_role : {};
  const current = (perRole[role] && typeof perRole[role] === 'object') ? perRole[role] : {};

  // 2) 服务端算价（防篡改）→ 分
  const priced = fulfill.computeAmountYuan({ planKey, role, period, current, paymentMode });
  if (!priced.ok) return { ok: false, code: priced.code, msg: '套餐校验失败' };
  const totalFee = fulfill.yuanToFen(priced.amount); // 道具单价（分）

  // 3) code2Session 取 session_key（用户态签名 signature 需要）
  let sessionKey = '';
  try {
    const s = await code2Session(code);
    sessionKey = s && s.session_key;
  } catch (e) {
    return { ok: false, code: 'SESSION_FAIL', msg: '登录态获取失败' };
  }
  if (!sessionKey) return { ok: false, code: 'NO_SESSION', msg: '登录态失效，请重试' };

  // 4) 复用未支付订单（防连点多单）或新建 pending
  const orders = db.collection('orders');
  const reuse = await orders.where({ _openid: OPENID, planKey, period, status: 'pending' })
    .orderBy('createdAt', 'desc').limit(1).get();
  let outTradeNo;
  if (reuse.data.length) {
    outTradeNo = reuse.data[0].outTradeNo;
  } else {
    outTradeNo = genOutTradeNo(OPENID);
    await orders.add({
      data: {
        outTradeNo, _openid: OPENID, planKey, role, period, paymentMode,
        amount: priced.amount, totalFee, paid: false, status: 'pending',
        source: 'virtual', createdAt: db.serverDate()
      }
    });
  }

  // 5) 构造道具直购 signData 并双签名
  const productId = PRODUCT_MAP[planKey + '_' + period] || (planKey + '_' + period);
  const signData = JSON.stringify({
    buyQuantity: 1,
    env: PAY_ENV,
    offerId: OFFER_ID,
    currencyType: 'CNY',
    productId,
    goodsPrice: totalFee,
    outTradeNo,
    attach: JSON.stringify({ role, planKey, period, paymentMode })
  });
  // paySig = hex(hmac_sha256(appKey, 'requestVirtualPayment&' + signData))
  const paySig = crypto.createHmac('sha256', APPKEY).update('requestVirtualPayment&' + signData).digest('hex');
  // signature = hex(hmac_sha256(session_key, signData))
  const signature = crypto.createHmac('sha256', sessionKey).update(signData).digest('hex');

  return { ok: true, outTradeNo, signData, paySig, signature, mode: 'short_series_goods', env: PAY_ENV };
};
