const data = require('../../services/data');

const VALID_METHODS = ['password', 'phone', 'email', 'wechat'];
const PHONE_RE = /^1\d{10}$/;
const CODE_RE = /^\d{6}$/;
const SAFE_ERROR_MESSAGES = {
  INVALID_PHONE: '请输入正确的手机号',
  SMS_TOO_FREQUENT: '验证码发送过于频繁，请稍后重试',
  SMS_CODE_INVALID: '验证码错误，请重新输入',
  SMS_CODE_EXPIRED: '验证码已过期，请重新获取',
  SMS_CODE_LOCKED: '验证码错误次数过多，请重新获取',
  INVALID_CREDENTIALS: '验证失败，请检查后重试',
  PASSWORD_RATE_LIMITED: '验证次数过多，请稍后重试',
  SESSION_REQUIRED: '登录状态已失效，请重新登录',
  SESSION_EXPIRED: '登录状态已失效，请重新登录'
};

function safeMessage(error, fallback) {
  return SAFE_ERROR_MESSAGES[error && error.code] || fallback;
}

function filterMethods(methods) {
  if (!Array.isArray(methods)) return [];
  const seen = Object.create(null);
  return methods.filter((method) => {
    if (VALID_METHODS.indexOf(method) === -1 || seen[method]) return false;
    seen[method] = true;
    return true;
  });
}

Component({
  properties: {
    visible: { type: Boolean, value: false },
    methods: { type: Array, value: [] }
  },

  data: {
    availableMethods: [],
    selectedMethod: '',
    password: '',
    phone: '',
    code: '',
    challengeId: '',
    sendingSms: false,
    sendingEmail: false,
    submitting: false,
    counting: false,
    countdown: 60
  },

  observers: {
    methods(methods) {
      const availableMethods = filterMethods(methods);
      this.resetSensitiveState();
      this.setData({
        availableMethods,
        selectedMethod: availableMethods.indexOf(this.data.selectedMethod) !== -1
          ? this.data.selectedMethod
          : (availableMethods[0] || '')
      });
    },
    visible(visible) {
      if (visible === false) this.resetSensitiveState();
    }
  },

  lifetimes: {
    attached() {
      this._detached = false;
      this._smsGeneration = 0;
      this._emailGeneration = 0;
      this._submitGeneration = 0;
    },
    detached() {
      this._detached = true;
      this.resetSensitiveState();
    }
  },

  pageLifetimes: {
    hide() {
      this.resetSensitiveState();
    }
  },

  methods: {
    resetSensitiveState() {
      this._smsGeneration = (this._smsGeneration || 0) + 1;
      this._emailGeneration = (this._emailGeneration || 0) + 1;
      this._submitGeneration = (this._submitGeneration || 0) + 1;
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
      this.setData({
        password: '',
        phone: '',
        code: '',
        challengeId: '',
        sendingSms: false,
        sendingEmail: false,
        submitting: false,
        counting: false,
        countdown: 60
      });
    },

    isCurrent(generationKey, generation) {
      return !this._detached && this[generationKey] === generation;
    },

    onMethodSelect(event) {
      const method = event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.method
        : '';
      if (this.data.availableMethods.indexOf(method) === -1 || method === this.data.selectedMethod) return;
      this.resetSensitiveState();
      this.setData({ selectedMethod: method });
    },

    onPasswordInput(event) {
      const password = event.detail.value;
      if (password !== this.data.password) {
        this._submitGeneration = (this._submitGeneration || 0) + 1;
        this.setData({ password, submitting: false });
        return;
      }
      this.setData({ password });
    },

    onPhoneInput(event) {
      const phone = event.detail.value;
      if (String(phone || '').trim() !== String(this.data.phone || '').trim()) {
        this._smsGeneration = (this._smsGeneration || 0) + 1;
        this._submitGeneration = (this._submitGeneration || 0) + 1;
        if (this._timer) {
          clearInterval(this._timer);
          this._timer = null;
        }
        this.setData({
          code: '',
          challengeId: '',
          sendingSms: false,
          submitting: false,
          counting: false,
          countdown: 60
        });
      }
      this.setData({ phone });
    },

    onCodeInput(event) {
      const code = event.detail.value;
      if (code !== this.data.code) {
        this._submitGeneration = (this._submitGeneration || 0) + 1;
        this.setData({ code, submitting: false });
        return;
      }
      this.setData({ code });
    },

    startCountdown(generation) {
      if (!this.isCurrent('_smsGeneration', generation)) return;
      if (this._timer) clearInterval(this._timer);
      this.setData({ counting: true, countdown: 60 });
      this._timer = setInterval(() => {
        if (!this.isCurrent('_smsGeneration', generation)) return;
        const countdown = this.data.countdown - 1;
        if (countdown <= 0) {
          clearInterval(this._timer);
          this._timer = null;
          this.setData({ counting: false, countdown: 60 });
        } else {
          this.setData({ countdown });
        }
      }, 1000);
    },

    sendPhoneCode() {
      if (this.data.sendingSms || this.data.counting) return;
      const phone = String(this.data.phone || '').trim();
      if (!PHONE_RE.test(phone)) {
        wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
        return;
      }
      const generation = (this._smsGeneration || 0) + 1;
      this._smsGeneration = generation;
      this._submitGeneration = (this._submitGeneration || 0) + 1;
      this.setData({ sendingSms: true, challengeId: '', code: '', submitting: false });
      data.sendSmsCode({ phone, purpose: 'reauth' })
        .then((result) => {
          if (!this.isCurrent('_smsGeneration', generation)) return;
          const challengeId = result && typeof result.challengeId === 'string'
            ? result.challengeId
            : '';
          this.setData({ sendingSms: false, challengeId });
          if (!challengeId) {
            wx.showToast({ title: '验证码发送失败，请稍后重试', icon: 'none' });
            return;
          }
          this.startCountdown(generation);
          wx.showToast({ title: '验证码已发送', icon: 'none' });
        })
        .catch((error) => {
          if (!this.isCurrent('_smsGeneration', generation)) return;
          this.setData({ sendingSms: false });
          if (error && error.code === 'AUTH_ATTEMPT_STALE') return;
          wx.showToast({ title: safeMessage(error, '验证码发送失败，请稍后重试'), icon: 'none' });
        });
    },

    sendBoundEmailCode() {
      if (this.data.sendingEmail) return;
      const generation = (this._emailGeneration || 0) + 1;
      this._emailGeneration = generation;
      this._submitGeneration = (this._submitGeneration || 0) + 1;
      this.setData({ sendingEmail: true, code: '', submitting: false });
      data.sendEmailCode({ purpose: 'reauth' })
        .then(() => {
          if (!this.isCurrent('_emailGeneration', generation)) return;
          this.setData({ sendingEmail: false });
          wx.showToast({ title: '验证码已发送', icon: 'none' });
        })
        .catch((error) => {
          if (!this.isCurrent('_emailGeneration', generation)) return;
          this.setData({ sendingEmail: false });
          if (error && error.code === 'AUTH_ATTEMPT_STALE') return;
          wx.showToast({ title: safeMessage(error, '验证码发送失败，请稍后重试'), icon: 'none' });
        });
    },

    submit() {
      if (this.data.submitting) return;
      const method = this.data.selectedMethod;
      if (this.data.availableMethods.indexOf(method) === -1) return;
      let payload;
      if (method === 'password') {
        const password = String(this.data.password || '');
        if (!password || password.length > 64) {
          wx.showToast({ title: '请输入当前密码', icon: 'none' });
          return;
        }
        payload = { method: 'password', password };
      } else if (method === 'phone') {
        const phone = String(this.data.phone || '').trim();
        const code = String(this.data.code || '').trim();
        const challengeId = String(this.data.challengeId || '');
        if (!PHONE_RE.test(phone)) {
          wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
          return;
        }
        if (!challengeId || !CODE_RE.test(code)) {
          wx.showToast({ title: '请先获取并输入 6 位验证码', icon: 'none' });
          return;
        }
        payload = { method: 'phone', phone, challengeId, code };
      } else if (method === 'email') {
        const code = String(this.data.code || '').trim();
        if (!CODE_RE.test(code)) {
          wx.showToast({ title: '请输入 6 位验证码', icon: 'none' });
          return;
        }
        payload = { method: 'email', code };
      } else {
        payload = { method: 'wechat' };
      }

      const generation = (this._submitGeneration || 0) + 1;
      this._submitGeneration = generation;
      this.setData({ submitting: true });
      data.reauthenticate(payload)
        .then(() => {
          if (!this.isCurrent('_submitGeneration', generation)) return;
          this.resetSensitiveState();
          this.setData({ visible: false });
          this.triggerEvent('authenticated');
        })
        .catch((error) => {
          if (!this.isCurrent('_submitGeneration', generation)) return;
          this.setData({ submitting: false });
          if (error && error.code === 'AUTH_ATTEMPT_STALE') return;
          wx.showToast({ title: safeMessage(error, '验证失败，请稍后重试'), icon: 'none' });
        });
    },

    cancel() {
      this.resetSensitiveState();
      this.setData({ visible: false });
      this.triggerEvent('cancel');
    }
  }
});
