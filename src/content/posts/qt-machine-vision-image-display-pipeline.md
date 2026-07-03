---
title: Qt 做机器视觉上位机，图像显示这块别只会往 QLabel 上塞图
published: 2026-07-03
description: '从采集线程、QImage 内存生命周期、显示丢帧策略到 ROI 坐标映射，整理 Qt 机器视觉上位机里图像显示链路的工程细节'
image: ''
tags: [Qt, 机器视觉, 上位机, 图像显示]
category: 技术笔记
draft: false
lang: zh
---

刚开始写机器视觉软件时，很容易把“显示图像”当成一个小功能：相机抓到一帧，转成 `QImage`，再丢给 `QLabel::setPixmap()`。如果只是 demo，这么写确实能亮图；但一旦接上工业相机、算法线程、ROI 编辑、结果叠加和连续运行，显示模块很快就会变成整个程序里最容易卡顿、最难排查的一块。

我踩过的坑大概可以总结成一句话：机器视觉里的图像显示，不是 UI 小组件问题，而是一条数据链路问题。它至少包含采集线程、图像内存、格式转换、帧率控制、坐标映射、叠加绘制和 UI 线程调度。哪一段偷懒，后面都会还债。

这篇主要聊 Qt Widgets 下怎么把这条链路设计得稳一点。

## 先把采集线程和 UI 线程分开

工业相机 SDK 的回调通常不在 Qt 主线程里。比如海康、大恒、Basler 这类 SDK，取图回调都是 SDK 自己的线程或者内部采集线程。这个线程里最忌讳做两件事：

1. 直接操作 Qt 控件。
2. 做太重的图像处理或绘制。

第一点是 Qt 的基本规矩，控件只能在 GUI 线程里改。第二点更容易被忽略：相机回调被你堵住以后，轻则显示延迟越来越大，重则 SDK 内部缓冲堆积，最后开始掉帧。

比较稳的做法是把采集回调当成“生产者”，只做很薄的一层事情：拿到指针、复制或引用必要的数据、打时间戳，然后把帧交给后面的队列。

一个简化后的结构大概是这样：

```cpp
struct VisionFrame {
    QByteArray bytes;
    int width = 0;
    int height = 0;
    int stride = 0;
    PixelFormat format = PixelFormat::Bgr8;
    qint64 cameraTimestamp = 0;
    qint64 hostTimestamp = 0;
};
```

注意这里我倾向于用一个明确的 `VisionFrame`，而不是在项目里到处传 `cv::Mat`、`QImage` 或者相机 SDK 的原始结构体。原因很简单：不同层关心的东西不一样。

采集层关心相机格式和时间戳，算法层关心矩阵和 ROI，UI 层关心显示尺寸和叠加元素。如果一开始就让 SDK 结构体穿透全项目，后面换相机、换算法库、加录像功能都会很别扭。

## QImage 的内存生命周期要想清楚

Qt 里有个经典坑：`QImage` 可以包一段外部内存，但它默认不拥有这段内存。

比如这样写：

```cpp
QImage image(buffer, width, height, stride, QImage::Format_BGR888);
emit frameReady(image);
```

如果 `buffer` 是相机 SDK 给的临时指针，或者是回调结束后会被复用的缓冲，这张 `QImage` 在 UI 线程真正绘制时，底层数据可能已经变了。表现出来就是花屏、偶现横线、偶现崩溃，最烦的是它不一定稳定复现。

我一般按场景选两种策略。

第一种是简单可靠：在采集边界复制一份数据，让 `VisionFrame::bytes` 拥有图像内存。

```cpp
VisionFrame frame;
frame.width = width;
frame.height = height;
frame.stride = stride;
frame.format = PixelFormat::Bgr8;
frame.bytes = QByteArray(reinterpret_cast<const char*>(buffer), stride * height);
```

这个方案会多一次拷贝，但稳定，适合 2000 万像素以下、帧率不太夸张的检测软件。很多产线视觉项目真正的瓶颈不在这一次拷贝，而在算法、存图、网络传输和 UI 同步。

第二种是做缓冲池。采集层提前分配几块固定内存，相机回调只往空闲缓冲写，后面模块用引用计数归还。这个适合高帧率或大分辨率项目，但实现复杂度会明显上去。没有性能数据之前，我不会一上来就写缓冲池。

## 显示可以丢帧，检测通常不该乱丢

机器视觉软件里有两条链路经常被混在一起：

1. 显示链路：给人看的，重点是流畅和低延迟。
2. 检测链路：给结果用的，重点是完整、可追溯和顺序正确。

显示链路没必要每帧都画。相机 60 FPS，显示器也就 60Hz，Qt 主线程还要处理按钮、表格、日志、绘制叠加层。UI 来不及画的时候，最合理的策略不是排队，而是只保留最新帧。

一个很朴素但实用的写法：

```cpp
class DisplayFrameBuffer : public QObject {
public:
    void push(VisionFrame frame)
    {
        QMutexLocker locker(&mutex_);
        latest_ = std::move(frame);
        hasFrame_ = true;
    }

    std::optional<VisionFrame> takeLatest()
    {
        QMutexLocker locker(&mutex_);
        if (!hasFrame_) {
            return std::nullopt;
        }
        hasFrame_ = false;
        return std::move(latest_);
    }

private:
    QMutex mutex_;
    VisionFrame latest_;
    bool hasFrame_ = false;
};
```

然后 UI 用 `QTimer` 以 30 或 60 FPS 去取最新帧：

```cpp
connect(&displayTimer_, &QTimer::timeout, this, [this] {
    auto frame = displayBuffer_.takeLatest();
    if (!frame) {
        return;
    }
    imageView_->setFrame(std::move(*frame));
});
displayTimer_.start(16);
```

这个方案有个好处：UI 忙的时候不会堆积一长串历史帧。人眼看到的是最新画面，延迟不会一路涨。

但检测链路不一定能这么干。触发式检测、扫码、尺寸测量、缺陷保存，这些都要求每个触发都能对上结果。如果检测算不过来，应该让状态机进入忙碌、报警或限流，而不是悄悄丢掉中间几帧。

## QLabel 能用，但不是长期方案

`QLabel::setPixmap()` 是最快能亮图的办法，但机器视觉界面往往需要这些能力：

1. 鼠标滚轮缩放。
2. 拖拽平移。
3. ROI 框编辑。
4. 十字线、标尺、检测框、文字结果叠加。
5. 图像坐标和屏幕坐标互相转换。

这些东西硬塞进 QLabel 也能做，但代码会越来越拧巴。我的习惯是做一个专门的 `ImageView`，继承 `QWidget` 或用 `QGraphicsView`。如果项目只是 2D 图像、叠加元素不多，直接继承 `QWidget` 重写 `paintEvent()` 就够用。

核心是维护一个从图像坐标到控件坐标的变换。

```cpp
class ImageView : public QWidget {
public:
    QPointF widgetToImage(const QPointF& p) const
    {
        return transform_.inverted().map(p);
    }

    QPointF imageToWidget(const QPointF& p) const
    {
        return transform_.map(p);
    }

protected:
    void paintEvent(QPaintEvent*) override
    {
        QPainter painter(this);
        painter.fillRect(rect(), QColor(30, 30, 30));

        if (image_.isNull()) {
            return;
        }

        painter.setTransform(transform_);
        painter.drawImage(QPointF(0, 0), image_);

        drawRois(painter);
        drawDetectionResults(painter);
    }

private:
    QImage image_;
    QTransform transform_;
};
```

这里有个小细节：叠加图形到底跟着图像一起缩放，还是保持屏幕线宽不变？

比如检测框，跟着图像缩放没问题；但 ROI 编辑时的控制点，如果也跟着图像缩放，放大后会很粗，缩小后又点不到。通常我会把“几何位置”放在图像坐标里，把“手柄大小、文字字号、线宽”放在屏幕坐标里单独画。这样交互手感会稳定很多。

## 格式转换别到处散落

相机出来的格式五花八门：Mono8、BayerRG8、BGR8、RGB8、YUV，有些还会给 12bit、16bit。Qt 显示常用的是 `QImage::Format_Grayscale8`、`Format_RGB888`、`Format_BGR888`、`Format_RGBA8888`。OpenCV 又习惯 BGR。

如果项目里每个页面都自己写一段转换，后面肯定乱。比较清爽的方式是把转换收在一个地方，比如：

```cpp
QImage makeDisplayImage(const VisionFrame& frame)
{
    switch (frame.format) {
    case PixelFormat::Mono8:
        return QImage(reinterpret_cast<const uchar*>(frame.bytes.constData()),
                      frame.width,
                      frame.height,
                      frame.stride,
                      QImage::Format_Grayscale8).copy();

    case PixelFormat::Bgr8:
        return QImage(reinterpret_cast<const uchar*>(frame.bytes.constData()),
                      frame.width,
                      frame.height,
                      frame.stride,
                      QImage::Format_BGR888).copy();

    default:
        return {};
    }
}
```

这里最后的 `.copy()` 看起来有点笨，但它明确让返回的 `QImage` 拥有自己的数据。如果你的 `VisionFrame` 生命周期能保证覆盖绘制过程，可以去掉这次 copy；问题是很多 UI bug 就是从“我觉得生命周期应该没问题”开始的。

Bayer 转 RGB 我不建议自己手写，直接用相机 SDK 或 OpenCV。尤其是颜色还原、白平衡、插值质量这些问题，自己写一个能跑的版本不难，写一个稳定可用的版本不划算。

## 叠加结果不要画死在图像上

检测框、文字、OK/NG、测量值这些结果，最好作为结构化数据传给 UI，而不是先用 OpenCV 画到图像上再显示。

比如：

```cpp
struct DetectionOverlay {
    QRectF box;
    QString label;
    QColor color;
    double score = 0.0;
};

struct DisplayPacket {
    VisionFrame frame;
    QVector<DetectionOverlay> overlays;
};
```

原因有三个。

第一，用户缩放图像时，叠加层可以重新绘制，不会糊。第二，可以支持点击某个缺陷框查看详情。第三，保存原图和保存带标注图可以分开做，后期追溯更干净。

工业现场里，追溯数据很重要。不要只保存一张画过框的 jpg，然后把原始数据覆盖掉。出了争议时，你需要知道算法当时看到的原图是什么，ROI 是什么，阈值是什么，结果框又是什么。

## 延迟要量，不要靠感觉

很多视觉软件的“卡”，其实有好几种：

1. 相机出图慢。
2. 算法耗时长。
3. UI 显示落后。
4. 存图阻塞。
5. 日志刷太多。

如果没有时间戳，只能靠猜。我的习惯是在帧对象里至少带三个时间：

```cpp
struct FrameTrace {
    qint64 capturedAt = 0;
    qint64 algorithmDoneAt = 0;
    qint64 displayedAt = 0;
};
```

调试界面上可以显示最近 100 帧的平均耗时：采集到算法完成多少毫秒，算法完成到显示多少毫秒，总延迟多少毫秒。这个功能不花哨，但现场调试特别有用。很多时候你会发现，真正拖慢软件的不是算法，而是每帧都在主线程里 `resize()` 大图，或者每个缺陷都同步写一行 Excel。

## 一个比较舒服的分层

最后给一个我比较常用的拆法：

1. `CameraWorker`：只负责相机打开、关闭、取图、触发、曝光参数。
2. `FrameDispatcher`：把帧分发给显示、算法、录像等消费者。
3. `AlgorithmWorker`：跑检测，不碰 Qt 控件。
4. `ImageView`：只负责显示图像和交互。
5. `ResultModel`：保存检测结果、统计和追溯字段。

这样拆的好处不是“架构好看”，而是问题能定位。显示卡了，就看 `ImageView` 和显示队列；算法慢了，就看 `AlgorithmWorker`；相机丢帧了，就看 `CameraWorker` 和 SDK 配置。

机器视觉软件长期运行后，最怕的不是一开始没有功能，而是功能全塞在一个窗口类里，三个月后谁也不敢动。Qt 本身不限制你怎么写，但它的线程模型、信号槽和绘制体系已经把边界暗示得很清楚了。顺着这些边界写，后面加 ROI、加多相机、加日志追溯都会轻松一些。
