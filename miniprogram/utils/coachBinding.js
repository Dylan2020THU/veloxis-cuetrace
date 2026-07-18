function statusLabel(application) {
  const status = application && application.status;
  if (status === 'approved') return '已绑定';
  if (status === 'rejected') return '已驳回';
  if (status === 'cancelled') return '已取消';
  if (status === 'pending') return '待店家确认';
  return '未申请';
}

function isPending(application) {
  return !!application && application.status === 'pending';
}

module.exports = { statusLabel, isPending };
