const data = require('../../services/data');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const MAX_POLL_ATTEMPTS = 8;
const POLL_INTERVAL_MS = 1500;

function parseCheckoutToken(options) {
  const input = options || {};
  if (typeof input.token === 'string' && TOKEN_PATTERN.test(input.token)) {
    return input.token;
  }
  if (typeof input.scene !== 'string') return '';
  let scene;
  try {
    scene = decodeURIComponent(input.scene);
  } catch (error) {
    return '';
  }
  const match = /^t=(.+)$/.exec(scene);
  return match && TOKEN_PATTERN.test(match[1]) ? match[1] : '';
}

function normalizePublicOrder(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    storeName: typeof source.storeName === 'string' ? source.storeName : '',
    tableName: typeof source.tableName === 'string' ? source.tableName : '',
    startedAt: source.startedAt,
    checkoutAt: source.checkoutAt,
    billedDurationMs: source.billedDurationMs,
    pricePerHourFen: source.pricePerHourFen,
    tableGrossFen: source.tableGrossFen,
    tableDiscountFen: source.tableDiscountFen,
    quotedTableFeeFen: source.quotedTableFeeFen,
    orderStatus: typeof source.orderStatus === 'string' ? source.orderStatus : '',
    paymentStatus: typeof source.paymentStatus === 'string' ? source.paymentStatus : '',
    canPay: source.canPay === true
  };
}

function formatFen(value) {
  if (!Number.isSafeInteger(value) || value < 0) return '--';
  return (value / 100).toFixed(2);
}

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return '--';
  const totalMinutes = Math.floor(value / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return hours + '小时' + minutes + '分钟';
  if (minutes > 0) return minutes + '分钟';
  return '不足1分钟';
}

function pad(value) {
  return value < 10 ? '0' + value : String(value);
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '--';
  return [
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()),
    pad(date.getHours()) + ':' + pad(date.getMinutes())
  ].join(' ');
}

function paymentStatusText(order) {
  if (order.paymentStatus === 'paid') return '支付已确认';
  if (order.paymentStatus === 'manual_review' || order.orderStatus === 'manual_review') {
    return '支付核验中';
  }
  if (order.canPay) return '待支付';
  return '暂不可支付';
}

function buildDisplay(order) {
  return {
    startedAtText: formatTime(order.startedAt),
    checkoutAtText: formatTime(order.checkoutAt),
    billedDurationText: formatDuration(order.billedDurationMs),
    pricePerHourText: formatFen(order.pricePerHourFen),
    tableGrossText: formatFen(order.tableGrossFen),
    tableDiscountText: formatFen(order.tableDiscountFen),
    quotedTableFeeText: formatFen(order.quotedTableFeeFen),
    paymentStatusText: paymentStatusText(order)
  };
}

function normalizePaymentParams(value) {
  const source = value && typeof value === 'object' ? value : {};
  const params = {
    timeStamp: source.timeStamp,
    nonceStr: source.nonceStr,
    package: source.package,
    signType: source.signType,
    paySign: source.paySign
  };
  const valid = /^\d+$/.test(params.timeStamp)
    && typeof params.nonceStr === 'string' && params.nonceStr.length > 0
    && typeof params.package === 'string' && params.package.length > 0
    && params.signType === 'RSA'
    && typeof params.paySign === 'string' && params.paySign.length > 0;
  if (!valid) throw new Error('Invalid payment parameters');
  return params;
}

function publicErrorText(error) {
  if (error && error.code === 'CLOUD_NOT_READY') return '云服务未连接，暂时无法结账';
  if (error && error.code === 'CHECKOUT_NOT_FOUND') return '结账订单不存在或已失效';
  return '订单加载失败，请稍后重试';
}

function paymentErrorText(error) {
  if (error && error.code === 'CLOUD_NOT_READY') return '云服务未连接，无法发起支付';
  if (error && error.retryable) return '支付订单创建中，请稍后重试';
  return '暂时无法发起支付，请稍后重试';
}

Page({
  behaviors: [require('../../utils/themeBehavior')],

  data: {
    loading: true,
    error: '',
    order: null,
    display: null,
    paying: false,
    polling: false,
    paymentHint: ''
  },

  onLoad(options) {
    this._destroyed = false;
    this._pageVisible = true;
    this._needsRefresh = false;
    this._payInFlight = false;
    this._pollGeneration = 0;
    this._orderRequestGeneration = 0;
    this._pollTimer = null;
    const token = parseCheckoutToken(options);
    if (!token) {
      this.setData({ loading: false, error: '无法识别结账码' });
      return;
    }
    this._checkoutToken = token;
    this.loadOrder();
  },

  onShow() {
    this._pageVisible = true;
    if (this._needsRefresh && this._checkoutToken) {
      this._needsRefresh = false;
      this.loadOrder({ silent: true });
    }
  },

  onHide() {
    this._pageVisible = false;
    this._needsRefresh = true;
    this.invalidateOrderRequests();
    this.stopStatusPolling();
  },

  onUnload() {
    this._destroyed = true;
    this._pageVisible = false;
    this.invalidateOrderRequests();
    this.stopStatusPolling();
    this._checkoutToken = '';
  },

  beginOrderRequest() {
    this._orderRequestGeneration = (this._orderRequestGeneration || 0) + 1;
    return this._orderRequestGeneration;
  },

  invalidateOrderRequests() {
    this._orderRequestGeneration = (this._orderRequestGeneration || 0) + 1;
  },

  isCurrentOrderRequest(generation) {
    return generation === this._orderRequestGeneration
      && !this._destroyed
      && this._pageVisible;
  },

  applyServerOrder(result) {
    if (!result || result.ok === false || !result.order) {
      throw new Error('Invalid public order response');
    }
    const order = normalizePublicOrder(result.order);
    this.setData({
      loading: false,
      error: '',
      order,
      display: buildDisplay(order)
    });
    return order;
  },

  loadOrder(options) {
    const settings = options || {};
    if (!this._checkoutToken) return Promise.resolve(null);
    const requestGeneration = this.beginOrderRequest();
    if (!settings.silent) this.setData({ loading: true, error: '' });
    return data.getTableCheckoutOrder({ token: this._checkoutToken })
      .then((result) => {
        if (!this.isCurrentOrderRequest(requestGeneration)) return null;
        const order = this.applyServerOrder(result);
        if (this.data.polling && (
          order.paymentStatus === 'paid'
          || order.paymentStatus === 'manual_review'
          || order.orderStatus === 'manual_review'
        )) {
          this.stopStatusPolling();
        }
        return order;
      })
      .catch((error) => {
        if (this.isCurrentOrderRequest(requestGeneration)) {
          this.setData({ loading: false, error: publicErrorText(error) });
        }
        return null;
      });
  },

  retryLoad() {
    this.loadOrder();
  },

  pay() {
    const order = this.data.order;
    if (this._payInFlight || this.data.polling || !order || !order.canPay || !this._checkoutToken) {
      return;
    }
    this._payInFlight = true;
    this.setData({ paying: true, paymentHint: '' });
    data.createTablePayOrder({ token: this._checkoutToken })
      .then((result) => {
        if (this._destroyed || !this._pageVisible) {
          this._payInFlight = false;
          if (!this._destroyed) this.setData({ paying: false });
          return;
        }
        const params = normalizePaymentParams(result);
        let callbackHandled = false;
        const handlePaymentCallback = () => {
          if (callbackHandled) return;
          callbackHandled = true;
          this._payInFlight = false;
          if (this._destroyed) return;
          this.setData({ paying: false, paymentHint: '正在向服务器核验支付结果…' });
          if (!this._pageVisible) {
            this._needsRefresh = true;
            return;
          }
          this.startStatusPolling();
        };
        wx.requestPayment({
          timeStamp: params.timeStamp,
          nonceStr: params.nonceStr,
          package: params.package,
          signType: params.signType,
          paySign: params.paySign,
          success: handlePaymentCallback,
          fail: handlePaymentCallback,
          complete: handlePaymentCallback
        });
      })
      .catch((error) => {
        this._payInFlight = false;
        if (this._destroyed) return;
        this.setData({ paying: false });
        wx.showToast({ title: paymentErrorText(error), icon: 'none' });
      });
  },

  startStatusPolling() {
    this.stopStatusPolling();
    if (this._destroyed || !this._checkoutToken) return;
    if (!this._pageVisible) {
      this._needsRefresh = true;
      return;
    }
    this._pollAttempts = 0;
    const generation = this._pollGeneration;
    this.setData({ polling: true });
    this.pollPaymentStatus(generation);
  },

  pollPaymentStatus(generation) {
    if (generation !== this._pollGeneration || this._destroyed || !this._pageVisible) return;
    this._pollAttempts += 1;
    const requestGeneration = this.beginOrderRequest();
    data.getTableCheckoutOrder({ token: this._checkoutToken })
      .then((result) => {
        if (generation !== this._pollGeneration || !this.isCurrentOrderRequest(requestGeneration)) return;
        const order = this.applyServerOrder(result);
        if (order.paymentStatus === 'paid') {
          this.stopStatusPolling();
          this.setData({ paymentHint: '支付已由服务器确认' });
          return;
        }
        if (order.paymentStatus === 'manual_review' || order.orderStatus === 'manual_review') {
          this.stopStatusPolling();
          this.setData({ paymentHint: '支付结果正在人工核验，请勿重复支付' });
          return;
        }
        this.scheduleNextPoll(generation);
      })
      .catch(() => {
        if (generation === this._pollGeneration && this.isCurrentOrderRequest(requestGeneration)) {
          this.scheduleNextPoll(generation);
        }
      });
  },

  scheduleNextPoll(generation) {
    if (generation !== this._pollGeneration || this._destroyed || !this._pageVisible) return;
    if (this._pollAttempts >= MAX_POLL_ATTEMPTS) {
      this.stopStatusPolling();
      this.setData({ paymentHint: '暂未查询到支付确认，请稍后刷新' });
      return;
    }
    this._pollTimer = setTimeout(() => {
      this._pollTimer = null;
      this.pollPaymentStatus(generation);
    }, POLL_INTERVAL_MS);
  },

  stopStatusPolling() {
    this._pollGeneration = (this._pollGeneration || 0) + 1;
    if (this._pollTimer !== null && this._pollTimer !== undefined) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (!this._destroyed) this.setData({ polling: false });
  }
});

module.exports = {
  MAX_POLL_ATTEMPTS,
  parseCheckoutToken
};
