// 旧付费墙兼容组件：商品已下线，调用方一律立即放行且不展示界面。
Component({
  data: {
    visible: false
  },

  methods: {
    show(_opts = {}, onResult) {
      this.setData({ visible: false });
      if (typeof onResult === 'function') onResult(true);
    },

    hide() {
      this.setData({ visible: false });
    },

    onClose() {
      this.hide();
    }
  }
});
