export function modelStatusHint(board) {
  return board.summaryConfigured ? `模型已配置：${board.summaryModel}` : '未配置模型：暂以原文字显示';
}
