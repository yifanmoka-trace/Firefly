---
title: 基于 Qt Widgets 的串口调试助手
published: 2026-06-14
description: '一个基于 Qt Widgets 开发的串口通信调试工具，支持多协议解析、实时波形显示与数据记录'
image: ''
tags: [Qt, C++, Widgets, 串口通信]
category: 项目展示
draft: false
lang: zh
---

## 项目概述

独立开发了一款串口调试助手，用于嵌入式开发过程中的串口通信调试。项目采用 Qt Widgets 构建 UI，实现了多协议数据解析、实时数据可视化与日志记录功能。

## 技术栈

- **框架**：Qt 5.15 / C++11
- **UI**：Qt Widgets、自定义控件、QSS 样式
- **通信**：QSerialPort 串口读写
- **绘图**：QChart 实时波形显示
- **数据**：QSettings 配置持久化、CSV 导出

## 核心功能

### 1. 串口通信管理

基于 `QSerialPort` 实现串口的自动检测、配置与读写：

```cpp
// 串口配置与打开
QSerialPort serial;
serial.setPortName("COM3");
serial.setBaudRate(QSerialPort::Baud115200);
serial.setDataBits(QSerialPort::Data8);
serial.setParity(QSerialPort::NoParity);
serial.open(QIODevice::ReadWrite);

// 数据接收：信号与槽驱动
connect(&serial, &QSerialPort::readyRead, this, [this]() {
    QByteArray data = serial.readAll();
    processIncomingData(data);
});
```

- 支持自动扫描可用串口
- 可配置波特率、数据位、校验位、停止位
- 支持十六进制 / ASCII 双模式收发

### 2. 多协议数据解析

设计了可扩展的协议解析框架，通过抽象基类支持多种协议：

```cpp
class ProtocolParser {
public:
    virtual ~ProtocolParser() = default;
    virtual bool parse(const QByteArray &raw, ParsedData &out) = 0;
    virtual QString name() const = 0;
};

class ModbusParser : public ProtocolParser {
    bool parse(const QByteArray &raw, ParsedData &out) override;
};
```

目前支持：原始 Hex、Modbus RTU、自定义帧协议。

### 3. 实时波形显示

利用 `QChart` + `QLineSeries` 实现数据的实时滚动波形：

- 支持多通道同时显示
- 自动缩放与滚动窗口
- 游标测量功能

### 4. 数据记录与导出

- 实时记录收发数据到日志文件
- 支持导出为 CSV 格式，方便后续分析
- 使用 `QSaveFile` 保证写入原子性

## 项目亮点

| 亮点 | 实现方式 |
|-----|---------|
| 异步非阻塞通信 | 信号与槽驱动，UI 不卡顿 |
| 可扩展协议框架 | 抽象基类 + 工厂模式，新增协议无需改动核心逻辑 |
| 自定义波形控件 | 继承 QChartView，封装缩放、游标等交互 |
| 配置持久化 | QSettings 保存窗口布局与串口参数 |

## 项目结构

```
SerialAssistant/
├── src/
│   ├── main.cpp
│   ├── MainWindow.cpp/h        # 主窗口与布局
│   ├── SerialManager.cpp/h     # 串口通信管理
│   ├── ProtocolParser.cpp/h    # 协议解析框架
│   ├── WaveformWidget.cpp/h    # 实时波形控件
│   └── ExportManager.cpp/h     # 数据导出
├── resources/
│   ├── icons/                  # 图标资源
│   └── style.qss              # 全局样式表
└── CMakeLists.txt
```

## 收获与反思

通过这个项目，我深入理解了 Qt 信号与槽机制在实际项目中的应用，掌握了自定义控件的开发方法，以及如何设计可扩展的软件架构。后续计划增加 QML 版本的 UI 界面，对比两种开发方式的体验差异。

---

> 📌 这是一个示例项目展示。你可以替换为你的真实项目，修改项目名称、功能描述和技术细节。保持"做了什么 → 怎么做的 → 收获什么"的叙事结构，最能体现你的技术深度。
