---
title: Qt + OpenCV 做视觉检测软件，重点不是跑通算法，而是把流程闭环
published: 2026-07-03
description: '围绕状态机、检测任务、参数快照、ROI 坐标、结构化结果和追溯保存，整理一套 Qt + OpenCV 视觉检测软件的工程骨架'
image: ''
tags: [Qt, OpenCV, 机器视觉, 工业检测]
category: 技术笔记
draft: false
lang: zh
---

很多人第一次做机器视觉项目，会把主要精力放在算法上：滤波、二值化、轮廓、模板匹配、深度学习推理。算法当然重要，但如果目标是做一套能在现场跑的 Qt 上位机，只把一张图算出结果还远远不够。

现场真正关心的是另一件事：每一次触发有没有被正确处理，结果有没有及时给出去，NG 图有没有保存，参数能不能追溯，操作员误点会不会把状态搞乱。也就是说，视觉软件的难点经常不在某个 OpenCV 函数，而在整条检测流程能不能闭环。

这篇聊一个比较接地气的 Qt + OpenCV 检测软件结构。不是大而全框架，更像是我会在中小型项目里采用的一套骨架。

## 从“按钮调用算法”改成状态机

最容易写出来的版本是这样的：

```cpp
void MainWindow::onDetectClicked()
{
    cv::Mat image = camera_.grab();
    auto result = algorithm_.run(image);
    ui->resultLabel->setText(result.ok ? "OK" : "NG");
}
```

demo 没问题，但现场软件一般不是这样运行。它会有相机连接、软触发、外部触发、连续检测、暂停、报警、参数切换、清料、复位等状态。如果还靠按钮槽函数堆逻辑，后面一定会长成一团。

我更愿意先定义几个清晰状态：

```cpp
enum class InspectState {
    Idle,
    CameraOpening,
    Ready,
    WaitingTrigger,
    Capturing,
    Inspecting,
    Reporting,
    Error
};
```

然后让按钮、PLC 信号、相机回调都只是“事件来源”，不要直接改一堆 UI 和业务变量。

```cpp
enum class InspectEvent {
    OpenCamera,
    CameraOpened,
    StartRun,
    TriggerArrived,
    FrameArrived,
    InspectFinished,
    StopRun,
    Fault
};
```

这看起来比直接写槽函数麻烦一点，但很值。因为你能明确回答这些问题：

1. 正在检测时又来了一个触发，接不接？
2. 相机掉线时按钮应该是什么状态？
3. 算法报错后是否还能继续接收下一帧？
4. 停止运行时，队列里的旧图要不要清掉？

这些问题没有统一答案，但必须在代码里有答案。否则现场一跑，最先暴露的就是状态混乱。

## 相机层不要绑定 OpenCV

OpenCV 很好用，但我不建议相机层直接返回 `cv::Mat` 给全项目到处传。原因和 Qt 项目里类似：`cv::Mat` 是算法层舒服的格式，不一定是采集层和 UI 层最合适的格式。

我一般会在相机层定义一个比较中性的帧结构：

```cpp
struct CameraFrame {
    QByteArray data;
    int width = 0;
    int height = 0;
    int stride = 0;
    PixelFormat pixelFormat = PixelFormat::Bgr8;
    quint64 frameId = 0;
    qint64 timestamp = 0;
};
```

算法线程需要 OpenCV 时再转换：

```cpp
cv::Mat toMat(const CameraFrame& frame)
{
    if (frame.pixelFormat == PixelFormat::Bgr8) {
        return cv::Mat(frame.height,
                       frame.width,
                       CV_8UC3,
                       const_cast<char*>(frame.data.constData()),
                       frame.stride).clone();
    }

    if (frame.pixelFormat == PixelFormat::Mono8) {
        return cv::Mat(frame.height,
                       frame.width,
                       CV_8UC1,
                       const_cast<char*>(frame.data.constData()),
                       frame.stride).clone();
    }

    return {};
}
```

这里用了 `.clone()`，是为了让算法拿到独立内存。很多时候算法会裁 ROI、画临时图、做形态学操作，不希望它误改采集缓冲。等性能压力真的上来了，再考虑减少这次拷贝。

## 参数不是全局变量

视觉检测里参数会越来越多：曝光、增益、阈值、ROI、模板路径、相机标定、像素比例、缺陷面积上下限、输出延迟。初期把它们放成一堆成员变量很快，但后面会遇到几个麻烦：

1. 不知道一次检测到底用了哪一版参数。
2. UI 修改参数时，算法线程正在读。
3. 参数保存了一半，程序崩了，配置文件坏掉。
4. 切换产品型号时，旧参数没清干净。

我更喜欢把检测参数做成一个不可变快照。UI 可以编辑草稿，点击应用后生成一个新的 `InspectConfig`，算法线程每次检测拿到的是一份明确的配置。

```cpp
struct InspectConfig {
    QString productName;
    QRect roi;
    double pixelSizeMm = 0.0;
    int threshold = 120;
    double minArea = 20.0;
    double maxArea = 5000.0;
    QString templatePath;
    int version = 0;
};
```

检测任务里把帧和配置绑在一起：

```cpp
struct InspectTask {
    CameraFrame frame;
    InspectConfig config;
    qint64 createdAt = 0;
};
```

这样结果出来时，你能知道它对应的是哪张图、哪套参数。现场追溯时，这比“当前界面上显示的参数”靠谱得多，因为界面参数可能早就被人改过了。

## 算法结果要结构化

很多新项目会让算法函数直接返回一张画好框的图。这个做法演示时很方便，但后期会受限。比如你想统计缺陷面积分布、导出 CSV、点击缺陷框查看原始轮廓、或者按不同颜色显示不同类别，这时候只有一张图就不够了。

我通常让算法返回结构化结果：

```cpp
struct DefectItem {
    QRectF box;
    double area = 0.0;
    double score = 0.0;
    QString type;
};

struct InspectResult {
    quint64 frameId = 0;
    bool ok = true;
    QVector<DefectItem> defects;
    double costMs = 0.0;
    QString message;
    InspectConfig config;
};
```

UI 要显示框，就根据 `defects` 画；要保存带标注图，也根据这些结构化数据去画。数据库或 CSV 里也能直接存面积、数量、类别和耗时。

这个习惯会让软件后期好维护很多。因为结果数据可以被 UI、日志、报表、PLC 输出同时使用，而不是每个地方都去解析一张图。

## ROI 坐标要统一在原图坐标里

ROI 是机器视觉软件里很容易写乱的部分。用户在界面上拖了一个框，控件坐标是 `(x, y, w, h)`；图像显示时可能缩放、居中、有黑边；算法处理时又可能裁剪、旋转、降采样。坐标一多，bug 就来了。

我的原则是：ROI、检测框、标定点全部存原图坐标。界面只负责做坐标映射。

```cpp
QRectF ImageView::widgetRectToImageRect(const QRectF& widgetRect) const
{
    const QPointF p1 = widgetToImage(widgetRect.topLeft());
    const QPointF p2 = widgetToImage(widgetRect.bottomRight());
    return QRectF(p1, p2).normalized();
}
```

算法层看到的永远是原图上的 ROI：

```cpp
cv::Rect toCvRect(const QRect& roi, const cv::Size& imageSize)
{
    QRect bounded = roi.intersected(QRect(0, 0, imageSize.width, imageSize.height));
    return cv::Rect(bounded.x(), bounded.y(), bounded.width(), bounded.height());
}
```

这里还有一个现场常见细节：ROI 一定要做边界裁剪。用户拖框、产品切换、相机分辨率变化，都可能让旧 ROI 超出当前图像。如果算法里直接拿这个 ROI 去裁 `cv::Mat`，OpenCV 会直接抛异常。

## UI 更新只认结果包

算法线程做完以后，不要在里面直接写 UI，也不要让它知道主窗口有哪些控件。它只发一个结果包：

```cpp
struct InspectPacket {
    CameraFrame frame;
    InspectResult result;
};
```

Qt 里可以用信号槽跨线程投递：

```cpp
connect(worker,
        &AlgorithmWorker::inspectFinished,
        this,
        &MainWindow::onInspectFinished,
        Qt::QueuedConnection);
```

主窗口收到后再做几件事：

1. 更新图像显示和叠加框。
2. 更新 OK/NG 计数。
3. 把结果写入表格或模型。
4. 通知 PLC 或外部系统。
5. 按策略保存原图、结果图和 JSON。

注意第 4 和第 5 件事不要阻塞 UI。尤其是保存图片，单张大图写盘几十毫秒很正常，如果直接在主线程里做，界面会周期性卡一下。更稳的办法是再丢给一个 `SaveWorker`。

## 保存结果时多存一点上下文

只保存 `OK.jpg`、`NG.jpg` 不够。现场复盘时经常会问：这张 NG 是哪个产品？哪个工位？哪套参数？阈值是多少？检测耗时多少？相机曝光是多少？

我习惯每次检测保存一个轻量 JSON，图片路径写进去：

```json
{
  "frameId": 10241,
  "product": "A-17",
  "result": "NG",
  "costMs": 18.6,
  "configVersion": 35,
  "roi": [120, 80, 640, 480],
  "defects": [
    { "type": "scratch", "box": [233, 141, 52, 18], "area": 734.5, "score": 0.91 }
  ],
  "rawImage": "images/10241_raw.bmp",
  "markedImage": "images/10241_marked.jpg"
}
```

这东西平时看着不起眼，出了问题就是关键材料。尤其是和客户、设备、电气一起定位问题时，一份完整记录比口头描述有用得多。

## 一个可落地的线程模型

中小型单相机项目，我一般会用这几个线程或对象：

1. UI 主线程：只做交互、显示、表格刷新。
2. `CameraWorker`：相机连接、取流、软触发、参数读写。
3. `AlgorithmWorker`：按顺序消费检测任务，输出结构化结果。
4. `SaveWorker`：异步保存原图、标注图、JSON、CSV。
5. `IoWorker`：和 PLC、串口、TCP 或 MES 通信。

单相机、低节拍项目可以少一些线程，但职责最好别混。最常见的卡顿来源就是 UI 线程既显示图像、又跑算法、又写文件、又发网络请求。平时看不出来，一到现场连续跑几个小时就开始各种不稳定。

任务队列也要有边界。比如算法队列最多只允许积压 1 到 3 个任务，超过就报警或拒绝新触发。无限队列看起来“不会丢”，实际只是把问题藏起来：延迟越来越大，最后结果和产品已经对不上。

## OpenCV 算法也要写成可测试的小函数

Qt 项目里经常把算法直接写进窗口类，调参数很方便，但后期很难测。我的习惯是让算法部分尽量脱离 UI：输入 `cv::Mat` 和 `InspectConfig`，输出 `InspectResult`。

```cpp
InspectResult inspectSurface(const cv::Mat& image, const InspectConfig& config)
{
    InspectResult result;
    result.config = config;

    const cv::Rect roi = toCvRect(config.roi, image.size());
    if (roi.empty()) {
        result.ok = false;
        result.message = "ROI is empty";
        return result;
    }

    cv::Mat gray;
    if (image.channels() == 3) {
        cv::cvtColor(image(roi), gray, cv::COLOR_BGR2GRAY);
    } else {
        gray = image(roi).clone();
    }

    cv::Mat binary;
    cv::threshold(gray, binary, config.threshold, 255, cv::THRESH_BINARY);

    std::vector<std::vector<cv::Point>> contours;
    cv::findContours(binary, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);

    for (const auto& contour : contours) {
        const double area = cv::contourArea(contour);
        if (area < config.minArea || area > config.maxArea) {
            continue;
        }

        const cv::Rect box = cv::boundingRect(contour);
        DefectItem item;
        item.area = area;
        item.type = "bright_area";
        item.box = QRectF(box.x + roi.x, box.y + roi.y, box.width, box.height);
        result.defects.push_back(item);
    }

    result.ok = result.defects.isEmpty();
    return result;
}
```

这个例子不复杂，但结构是对的。你可以拿一批样图直接跑这个函数，验证参数和结果，不需要启动 Qt 界面，也不需要连相机。等项目变大，这种可测试性会省很多时间。

## 最后别忘了现场操作体验

视觉软件不是写给程序员看的。操作员关心的是当前状态清不清楚，异常能不能看懂，误操作有没有保护。几个很朴素的细节会明显提升可用性：

1. OK/NG 用稳定位置的大状态显示，不要只在日志里写一行。
2. 报警信息说人话，比如“相机未连接”，不要只显示错误码 `0x80000203`。
3. 参数修改后要有“未应用”提示，避免界面值和实际检测值不一致。
4. 产品型号切换要清空旧结果，避免新旧数据混在一起。
5. 关键按钮根据状态启用和禁用，不要让用户在检测中乱点“打开相机”。

这些东西看起来不如算法酷，但现场稳定性很大一部分就靠它们。一个好的 Qt 视觉检测软件，应该让相机、算法、UI、IO、存储都有明确边界；每次检测从触发到结果输出都有记录；出了问题能回看，而不是靠猜。

算法跑通只是第一步。真正能交付的系统，要把流程、状态、数据和人机交互都收住。
