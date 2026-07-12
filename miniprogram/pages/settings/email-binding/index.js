const data = require('../../../services/data');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;
const SAFE_EMAIL_ERROR_MESSAGES = {
  EMAIL_INVALID: '邮箱格式不正确',
  EMAIL_ALREADY_BOUND: '该邮箱已被绑定',
  EMAIL_CODE_COOLDOWN: '验证码发送过于频繁，请稍后重试',
  EMAIL_CODE_INVALID: '验证码错误，请重新输入',
  EMAIL_CODE_EXPIRED: '验证码已过期，请重新获取',
  EMAIL_CODE_LOCKED: '验证码错误次数过多，请稍后重试',
  EMAIL_NOT_CONFIGURED: '邮箱服务暂不可用，请稍后重试',
  EMAIL_SEND_FAILED: '验证码发送失败，请稍后重试',
  CLOUD_NOT_READY: '云服务未就绪，请稍后重试'
};

function getSafeEmailErrorMessage(error, fallback) {
  const message = SAFE_EMAIL_ERROR_MESSAGES[error && error.code];
  return typeof message === 'string' ? message : fallback;
}

Page({
  behaviors: [require('../../../utils/themeBehavior')],

  data: {
    email: '',
    code: '',
    sending: false,
    counting: false,
    countdown: 60,
    currentEmail: '未绑定'
  },

  onLoad() {
    this._disposed = false;
    this._active = true;
  },

  onShow() {
    this._active = true;
    this.refresh();
  },

  refresh() {
    const requestToken = this.invalidateStatusRequest();
    data.getAccountSecurity()
      .then((status) => {
        if (!this.isCurrentRequest('_statusRequestToken', requestToken)) return;
        this.setData({
          currentEmail: status.emailBound && status.emailMasked ? status.emailMasked : '未绑定'
        });
      })
      .catch(() => {
        if (!this.isCurrentRequest('_statusRequestToken', requestToken)) return;
        this.setData({ currentEmail: '未绑定' });
      });
  },

  invalidateStatusRequest() {
    this._statusRequestToken = (this._statusRequestToken || 0) + 1;
    return this._statusRequestToken;
  },

  invalidateSendRequest() {
    this._sendRequestToken = (this._sendRequestToken || 0) + 1;
    return this._sendRequestToken;
  },

  invalidateBindRequest() {
    this._bindRequestToken = (this._bindRequestToken || 0) + 1;
    return this._bindRequestToken;
  },

  isCurrentRequest(key, requestToken) {
    return !this._disposed && this._active !== false && requestToken === this[key];
  },

  onEmailInput(event) {
    const email = event.detail.value;
    if (email.trim() !== (this.data.email || '').trim()) {
      this.cancelSendRequest();
    }
    this.setData({ email });
  },

  onCodeInput(event) {
    this.setData({ code: event.detail.value });
  },

  clearCountdown() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  cancelSendRequest() {
    this.invalidateSendRequest();
    this.clearCountdown();
    if (!this._disposed) {
      this.setData({ sending: false, counting: false, countdown: 60 });
    }
  },

  startCountdown() {
    this.clearCountdown();
    this.setData({ counting: true, countdown: 60 });
    this._timer = setInterval(() => {
      if (this._disposed || this._active === false) return;
      const next = this.data.countdown - 1;
      if (next <= 0) {
        this.clearCountdown();
        this.setData({ counting: false, countdown: 60 });
      } else {
        this.setData({ countdown: next });
      }
    }, 1000);
  },

  sendCode() {
    if (this.data.sending || this.data.counting) return;
    const email = (this.data.email || '').trim();
    if (!EMAIL_RE.test(email)) {
      wx.showToast({ title: '请输入正确的邮箱', icon: 'none' });
      return;
    }

    this.setData({ sending: true });
    const requestToken = this.invalidateSendRequest();
    data.sendEmailCode({ purpose: 'bind', email })
      .then(() => {
        if (!this.isCurrentRequest('_sendRequestToken', requestToken)) return;
        this.setData({ sending: false });
        this.startCountdown();
        wx.showToast({ title: '验证码已发送', icon: 'none' });
      })
      .catch((error) => {
        if (!this.isCurrentRequest('_sendRequestToken', requestToken)) return;
        this.setData({ sending: false });
        wx.showToast({
          title: getSafeEmailErrorMessage(error, '验证码发送失败，请稍后重试'),
          icon: 'none'
        });
      });
  },

  submit() {
    if (this._binding) return;
    const email = (this.data.email || '').trim();
    const code = (this.data.code || '').trim();
    if (!EMAIL_RE.test(email)) {
      wx.showToast({ title: '请输入正确的邮箱', icon: 'none' });
      return;
    }
    if (!CODE_RE.test(code)) {
      wx.showToast({ title: '请输入 6 位验证码', icon: 'none' });
      return;
    }

    this._binding = true;
    const requestToken = this.invalidateBindRequest();
    data.bindEmail({ email, code })
      .then(() => {
        if (!this.isCurrentRequest('_bindRequestToken', requestToken)) return;
        this._binding = false;
        this.clearCountdown();
        wx.showModal({
          title: '绑定成功',
          content: '邮箱已绑定，可用于账号安全与密码找回。',
          showCancel: false,
          success: () => {
            if (this.isCurrentRequest('_bindRequestToken', requestToken)) wx.navigateBack();
          }
        });
      })
      .catch((error) => {
        if (!this.isCurrentRequest('_bindRequestToken', requestToken)) return;
        this._binding = false;
        wx.showToast({
          title: getSafeEmailErrorMessage(error, '邮箱绑定失败，请稍后重试'),
          icon: 'none'
        });
      });
  },

  deactivate() {
    this._active = false;
    this.invalidateStatusRequest();
    this.cancelSendRequest();
    this.invalidateBindRequest();
    this._binding = false;
  },

  onHide() {
    this.deactivate();
  },

  onUnload() {
    this._disposed = true;
    this.deactivate();
  }
});
