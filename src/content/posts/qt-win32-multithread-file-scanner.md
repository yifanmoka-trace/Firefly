---
title: 用 Qt、Win32 API 和 STL 写一个可取消的多线程文件扫描器
published: 2026-07-03
description: '从 FileScanner 的实现出发，复盘目录任务队列、pendingDirectories_ 完成判断、condition_variable 等待、Win32 枚举和协作式取消。'
image: ''
tags: [Qt, C++, 多线程, Win32, 文件系统]
category: 技术笔记
draft: false
lang: zh
---

文件扫描这个需求很适合练工程基本功。它看起来只是遍历目录，但稍微认真一点就会遇到几个问题：目录树可能很深，文件数量可能很多，UI 不能卡死，用户还可能随时点停止。

这个项目里，我把扫描逻辑放在 `FileScannerEngine` 里，底层枚举目录用 Win32 API，线程和同步用 C++ 标准库。Qt 只在外层做界面展示，不参与核心扫描调度。

## 基本模型：多个 worker 消费一个目录队列

扫描目录树最直接的方式是递归：扫到子目录就递归进去。单线程递归实现简单，但目录很多时吞吐不够，而且取消和进度通知也不太好控制。

这里改成一个生产者/消费者模型：启动时把根目录放进 `dirQueue_`，启动多个 worker 线程，每个 worker 从队列里取一个目录扫描。扫到文件就记录结果并回调，扫到子目录就重新放回队列，所有目录处理完后触发完成回调。

核心状态大概是这样：

```cpp
std::queue<std::wstring> dirQueue_;
std::mutex queueMutex_;
std::condition_variable queueCv_;

std::atomic<int> pendingDirectories_{0};
std::atomic<bool> cancelRequested_{false};
std::atomic<bool> finishNotified_{false};

std::vector<std::thread> workers_;
```

`dirQueue_` 保存待扫描目录，`condition_variable` 用来让空闲线程睡眠，`pendingDirectories_` 用来判断整棵目录树是否已经处理完。

## pendingDirectories_ 比队列是否为空更可靠

多线程扫描时，不能简单地用“队列为空”判断扫描结束。因为队列为空只能说明此刻没有待取任务，不代表其他线程不会马上发现新的子目录。

比如线程 A 正在扫描 `C:\test`，线程 B 发现队列空了。如果 B 直接认为结束，就错了，因为 A 可能下一秒扫到 `C:\test\sub` 并入队。

所以这里用 `pendingDirectories_` 表示“还没完成的目录任务数”。根目录入队时算一个任务：

```cpp
dirQueue_.push(rootPath);
pendingDirectories_.store(1, std::memory_order_release);
```

发现子目录时加一：

```cpp
void FileScannerEngine::pushDirectory(std::wstring directory)
{
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        dirQueue_.push(std::move(directory));
        pendingDirectories_.fetch_add(1, std::memory_order_acq_rel);
    }
    queueCv_.notify_one();
}
```

一个目录扫描完成后减一：

```cpp
if (pendingDirectories_.fetch_sub(1, std::memory_order_acq_rel) == 1) {
    maybeFinish(cancelRequested_.load(std::memory_order_acquire));
}
```

`fetch_sub` 返回的是减之前的值。如果减之前是 1，说明当前目录就是最后一个未完成任务，扫描可以收尾。

这个计数是整个调度里最关键的点。它把“正在扫描的目录”和“队列里等待的目录”都算进去了，因此比单看队列状态更准确。

## worker 如何等待任务

线程不能在 while 循环里空转查队列，否则 CPU 会被白白占满。这里用 `condition_variable` 等待：

```cpp
bool FileScannerEngine::tryPopDirectory(std::wstring& directory)
{
    std::unique_lock<std::mutex> lock(queueMutex_);

    queueCv_.wait(lock, [this] {
        return !dirQueue_.empty()
            || pendingDirectories_.load(std::memory_order_acquire) == 0
            || cancelRequested_.load(std::memory_order_acquire);
    });

    if (cancelRequested_.load(std::memory_order_acquire)) {
        return false;
    }

    if (dirQueue_.empty()) {
        return false;
    }

    directory = std::move(dirQueue_.front());
    dirQueue_.pop();
    return true;
}
```

这个等待条件包含三种情况：队列里有新目录，可以继续干活；`pendingDirectories_ == 0`，全部结束；用户请求取消，线程应该退出。

`wait(lock, predicate)` 还能处理虚假唤醒。线程被唤醒后会重新检查条件，不满足就继续睡。

## 用 FindFirstFileW 枚举目录

扫描单个目录时，用的是 Win32 的宽字符接口：

```cpp
const std::wstring searchPattern = joinPath(directory, L*);
WIN32_FIND_DATAW findData{};
const HANDLE findHandle = FindFirstFileW(searchPattern.c_str(), &findData);
if (findHandle == INVALID_HANDLE_VALUE) {
    return;
}
```

遍历时要跳过 `.` 和 `..`：

```cpp
const wchar_t* name = findData.cFileName;

if (wcscmp(name, L.) == 0 || wcscmp(name, L..) == 0) {
    continue;
}
```

如果是目录，就加入队列：

```cpp
if (findData.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
    pushDirectory(fullPath);
    continue;
}
```

如果是普通文件，就记录路径和大小：

```cpp
const std::int64_t fileSize = combineFileSize(findData.nFileSizeLow,
                                              findData.nFileSizeHigh);

{
    std::lock_guard<std::mutex> lock(stateMutex_);
    summary_.files.push_back(FileEntry{fullPath, fileSize});
    summary_.totalSize += fileSize;
}
```

Win32 把文件大小拆成高低两个 32 位字段，需要合并成 64 位：

```cpp
std::int64_t FileScannerEngine::combineFileSize(unsigned long low, unsigned long high)
{
    ULARGE_INTEGER size{};
    size.LowPart = low;
    size.HighPart = high;
    return static_cast<std::int64_t>(size.QuadPart);
}
```

最后一定要 `FindClose(findHandle)`。句柄泄漏在文件扫描这种高频操作里很隐蔽，目录一多就会变成稳定性问题。

## 取消不是强杀线程

这个扫描器的取消逻辑是协作式的：用户点停止后，只设置一个原子标志并唤醒等待线程。

```cpp
void FileScannerEngine::cancel()
{
    cancelRequested_.store(true, std::memory_order_release);
    queueCv_.notify_all();
}
```

worker 会在几个位置检查这个标志：取任务前、扫描目录循环里、等待条件里。这样线程可以自己走到安全位置退出，而不是被外部强行终止。

```cpp
while (true) {
    if (cancelRequested_.load(std::memory_order_acquire)) {
        break;
    }

    std::wstring directory;
    if (!tryPopDirectory(directory)) {
        break;
    }

    scanDirectory(directory);
    // 当前目录处理完成后再扣 pendingDirectories_
}
```

协作式取消的缺点是不会“瞬间停止”。如果某个系统调用刚好在枚举一个很慢的目录，它要等当前操作返回后才会退出。但好处是资源状态清楚，不会把锁、句柄、容器留在半截状态。

## 完成回调只能触发一次

多线程里很容易出现多个线程同时认为“我应该收尾”的情况。正常扫描结束时，最后一个目录任务会触发完成；取消时，最后一个退出的 worker 也可能触发完成。

所以这里用 `finishNotified_` 做一次性保护：

```cpp
void FileScannerEngine::maybeFinish(bool cancelled)
{
    bool expected = false;
    if (!finishNotified_.compare_exchange_strong(expected, true,
                                                 std::memory_order_acq_rel)) {
        return;
    }
    finishScan(cancelled);
}
```

`compare_exchange_strong` 成功的那个线程负责调用 `finishScan`，其他线程直接返回。这个写法比再套一层锁更轻，而且语义很直接：完成通知只允许从 `false` 切到 `true` 一次。

## 析构时必须等线程退出

扫描引擎析构时不能只设置取消标志就结束。对象都销毁了，后台线程如果还在访问成员变量，就是典型的悬空访问。

```cpp
FileScannerEngine::~FileScannerEngine()
{
    cancel();
    for (std::thread& worker : workers_) {
        if (worker.joinable()) {
            worker.join();
        }
    }
}
```

这里有一个细节：`finishScan` 里不能 join worker，因为 `finishScan` 可能就是某个 worker 线程自己调用的。线程 join 自己会死锁。所以 join 放在析构或下一次 start 前处理。

## 小结

这个扫描器的核心并不复杂，但几个点必须想清楚：用目录队列替代递归，方便多线程分工；用 `pendingDirectories_` 判断整体完成，而不是只看队列是否为空；用 `condition_variable` 避免空转；用原子标志实现协作式取消；用一次性标志保证完成回调只触发一次；析构时取消并 join，保证线程不会访问已销毁对象。

这些东西单独看都不新，但组合在一个能跑的 Qt 小工具里，就能体现出工程代码和 demo 代码的差别。

> 相关阅读：[FileScanner：多线程文件扫描引擎的设计与实现](/posts/project-file-scanner/)
