---
title: Qt 调 DLL 扫描文件时，进度回调为什么不能直接更新界面
published: 2026-07-03
description: '从 FileScanner 的 UI 层实现出发，解释后台 DLL 回调、Qt 主线程更新、QTimer 节流、QueuedConnection 和批量结果读取。'
image: ''
tags: [Qt, C++, 多线程, UI, DLL]
category: 技术笔记
draft: false
lang: zh
---

这个文件扫描器的界面很简单：选择目录、开始、停止、显示进度、显示最终结果。真正容易出问题的地方不是控件布局，而是扫描线程和 Qt 主线程之间的数据交接。

DLL 的扫描引擎会启动多个 `std::thread`。每个线程发现文件时都会触发 progress 回调。如果在这个回调里直接操作 Qt 控件，程序可能短时间看起来没问题，但本质上是不安全的。

Qt 的 UI 对象应该只在主线程访问。后台线程直接改 `QLabel`、`QListWidget`、`QTableWidget`，轻则偶发卡顿和刷新异常，重则崩溃。

## 回调来自后台线程

扫描开始时，Qt 界面把两个静态回调传给 DLL：

```cpp
const int started = FileScanner_Start(scannerHandle_,
                                      widePath.c_str(),
                                      &MainWindow::progressCallback,
                                      &MainWindow::finishedCallback,
                                      this);
```

这里传入的 `this` 会作为 `userData` 原样带回。回调函数是 `static`，通过 `userData` 找回窗口对象：

```cpp
void MainWindow::progressCallback(const wchar_t *path,
                                  std::int64_t size,
                                  void *userData)
{
    auto *window = static_cast<MainWindow *>(userData);
    if (window == nullptr || path == nullptr) {
        return;
    }

    {
        std::lock_guard<std::mutex> lock(window->progressMutex_);
        window->latestPath_ = QString::fromWCharArray(path);
        window->latestSize_ = static_cast<qint64>(size);
    }
    window->discoveredCount_.fetch_add(1, std::memory_order_relaxed);
}
```

注意这个函数里没有更新任何控件。它只做两件事：保存最新路径和大小、把已发现文件数加一。

这是故意的。progress 回调可能由多个 worker 线程同时调用，里面做的事情越少越好。

## 高频进度不适合每条都投递 UI 事件

很多人第一反应是：既然不能直接更新 UI，那我每次回调都用 `QMetaObject::invokeMethod` 投递到主线程不就行了吗？可以，但在文件扫描这种场景下不一定合适。

如果一个目录下面有几万、几十万个文件，每个文件都投递一次 UI 更新，主线程的事件队列会被塞满。扫描本身可能很快，但界面会忙着处理大量过期进度。用户看到的结果就是卡、慢、停止按钮响应迟钝。

这个项目里进度采用“后台线程写最新值，主线程定时刷新”的方式。构造函数里创建一个 100ms 的定时器：

```cpp
progressTimer_ = new QTimer(this);
progressTimer_->setInterval(100);
connect(progressTimer_, &QTimer::timeout,
        this, &MainWindow::refreshProgressUi);
```

开始扫描后启动定时器：

```cpp
progressTimer_->start();
```

主线程每 100ms 批量刷新一次：

```cpp
void MainWindow::refreshProgressUi()
{
    const int total = discoveredCount_.load(std::memory_order_relaxed);
    if (total <= progressCount_) {
        return;
    }

    QString path;
    qint64 size = 0;
    {
        std::lock_guard<std::mutex> lock(progressMutex_);
        path = latestPath_;
        size = latestSize_;
    }

    progressCount_ = total;
    ui->labelCurrentFile->setText(
        tr("当前文件: %1").arg(QFontMetrics(ui->labelCurrentFile->font())
                               .elidedText(path, Qt::ElideMiddle,
                                           ui->labelCurrentFile->width())));

    const QString line = tr("[%1] %2  (%3)")
                             .arg(progressCount_)
                             .arg(path)
                             .arg(formatSize(size));
    ui->listProgress->addItem(line);
    while (ui->listProgress->count() > kMaxProgressListItems) {
        delete ui->listProgress->takeItem(0);
    }
    ui->listProgress->scrollToBottom();
}
```

这个方案牺牲了“每个文件都实时显示”的精确性，但换来了更稳定的界面响应。进度展示本来就是给人看的，100ms 的刷新粒度已经足够自然。

## 为什么只保留最近 200 条进度

扫描时的进度列表不是最终结果表，它只是让用户知道程序还在工作。一直往 `QListWidget` 里塞数据没有意义，文件多了以后还会明显拖慢 UI。

所以这里限制最多保留 200 条：

```cpp
while (ui->listProgress->count() > kMaxProgressListItems) {
    delete ui->listProgress->takeItem(0);
}
```

最终完整结果不靠这个列表展示，而是在扫描完成后从 DLL 批量读取，再填入表格。

这个区分很重要：进度区域应该轻，结果区域才需要完整。

## 完成回调用 QueuedConnection 回到主线程

完成回调频率很低，只会触发一次，所以这里直接用 `QMetaObject::invokeMethod` 投递到主线程：

```cpp
void MainWindow::finishedCallback(int fileCount,
                                  std::int64_t totalSize,
                                  int cancelled,
                                  void *userData)
{
    auto *window = static_cast<MainWindow *>(userData);
    if (window == nullptr) {
        return;
    }

    QMetaObject::invokeMethod(window,
                              "onScanFinished",
                              Qt::QueuedConnection,
                              Q_ARG(int, fileCount),
                              Q_ARG(qint64, static_cast<qint64>(totalSize)),
                              Q_ARG(bool, cancelled != 0));
}
```

`Qt::QueuedConnection` 的作用是把调用排进接收对象所属线程的事件队列。`MainWindow` 属于主线程，所以 `onScanFinished` 会在主线程执行。

完成后的处理就可以安全操作 UI：

```cpp
void MainWindow::onScanFinished(int fileCount,
                                qint64 totalSize,
                                bool cancelled)
{
    progressTimer_->stop();
    refreshProgressUi();

    loadResultsFromDll();
    setUiBusy(false);

    if (cancelled) {
        statusBar()->showMessage(tr("扫描已停止：共 %1 个文件，合计 %2")
                                     .arg(fileCount)
                                     .arg(formatSize(totalSize)));
    } else {
        statusBar()->showMessage(tr("扫描完成：共 %1 个文件，合计 %2")
                                     .arg(fileCount)
                                     .arg(formatSize(totalSize)));
    }
}
```

高频 progress 用定时器合并，低频 finished 用 queued invoke，这是这个界面层最核心的取舍。

## 批量读取结果再填表

扫描完成后，界面先问 DLL 有多少结果：

```cpp
const int count = FileScanner_GetResultCount(scannerHandle_);
if (count <= 0) {
    ui->tableResults->setRowCount(0);
    return;
}
```

然后一次性分配路径和大小缓冲区：

```cpp
std::vector<wchar_t> pathBuffer(static_cast<std::size_t>(count) * kPathBufferCapacity);
std::vector<std::int64_t> sizeBuffer(static_cast<std::size_t>(count));
```

从 DLL 批量取回结果：

```cpp
const int fetched = FileScanner_GetResults(scannerHandle_,
                                           pathBuffer.data(),
                                           sizeBuffer.data(),
                                           count,
                                           kPathBufferCapacity);
```

最后再填 `QTableWidget`：

```cpp
for (int i = 0; i < fetched; ++i) {
    const wchar_t *pathPtr = pathBuffer.data()
        + static_cast<std::size_t>(i) * kPathBufferCapacity;
    const QString path = QString::fromWCharArray(pathPtr);
    const qint64 size = static_cast<qint64>(sizeBuffer[static_cast<std::size_t>(i)]);

    ui->tableResults->setItem(i, 0, new QTableWidgetItem(path));
    ui->tableResults->setItem(i, 1, new QTableWidgetItem(formatSize(size)));
}
```

这种方式让扫描阶段尽量轻，UI 阶段集中处理最终展示。对于小工具来说，这比在扫描过程中持续维护一张完整表格更简单，也更稳。

## 小结

Qt 调后台 DLL 时，我会把线程交接分成两类处理：高频进度只共享最新状态，由主线程定时刷新；低频完成事件用 `Qt::QueuedConnection` 投递回主线程。

这个思路背后其实就一句话：后台线程负责干活，主线程负责界面。两边通过很窄的数据通道交接，程序就不容易因为“偶尔能跑”而埋下随机崩溃的坑。

> 相关阅读：[FileScanner：多线程文件扫描引擎的设计与实现](/posts/project-file-scanner/)
