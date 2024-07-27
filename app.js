import * as fs from 'fs'
import cookieParser from 'cookie-parser'
import createError from 'http-errors'
import logger from 'morgan'
import path from 'path'
import bodyParser from 'body-parser'
import express from 'express'
import dotenv from 'dotenv'
import session from 'express-session'
import sessionFileStore from 'session-file-store'
import db from './configs/mysql.js' // 引入 MySQL 連接池
import reservationRoutes from './routes/reservation.js'
import memberRoutes from './routes/member.js'
import historyRoutes from './routes/history.js'
import paymentRoutes from './routes/payment.js'
import { fileURLToPath, pathToFileURL } from 'url'
//這是聊天用管道 我把它設為聊天室專用
import http from 'http'
//引入socket.io
import { Server } from 'socket.io'
//使用跨源
import cors from 'cors'

// 計算 __dirname 替代
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 使用檔案的session store，存在sessions資料夾
const FileStore = sessionFileStore(session)

// 讓console.log呈現檔案與行號，與字串訊息呈現顏色用
import { extendLog } from '#utils/tool.js'
import 'colors'
extendLog()

// 建立 Express 應用程式
const app = express()

// 設定 port
const port = 3001

// 設置環境變量
dotenv.config()

// 打印環境變量
console.log('DB_HOST:', process.env.DB_HOST)
console.log('DB_PORT:', process.env.DB_PORT)
console.log('DB_DATABASE:', process.env.DB_DATABASE)
console.log('DB_USERNAME:', process.env.DB_USERNAME)
console.log('DB_PASSWORD:', process.env.DB_PASSWORD)

// 視圖引擎設定
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))

// 使用中介軟體
app.use(bodyParser.json()) // 解析 JSON 資料
app.use(logger('dev')) // 記錄 HTTP 要求
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cookieParser())
app.use(express.static(path.join(__dirname, 'public')))

// cors設定，參數為必要，注意不要只寫`app.use(cors())`
app.use(
  cors({
    origin: ['http://localhost:3000', 'https://localhost:9000', '*'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  })
)

// fileStore的選項 session-cookie使用
const fileStoreOptions = { logFn: function () {} }
app.use(
  session({
    store: new FileStore(fileStoreOptions), // 使用檔案記錄session
    name: 'SESSION_ID', // cookie名稱，儲存在瀏覽器裡
    secret: '67f71af4602195de2450faeb6f8856c0', // 安全字串，應用一個高安全字串
    cookie: {
      maxAge: 30 * 86400000, // 30 * (24 * 60 * 60 * 1000) = 30 * 86400000 => session保存30天
    },
    resave: false,
    saveUninitialized: false,
  })
)

// 檢查 MySQL 連接
;(async () => {
  try {
    const connection = await db.getConnection()
    console.log('MySQL 連接成功')
    connection.release()
  } catch (error) {
    console.error('MySQL 連接失敗:', error)
  }
})()

// 載入routes中的各路由檔案，並套用api路由 START
const apiPath = '/api' // 預設路由
const routePath = path.join(__dirname, 'routes')
const filenames = await fs.promises.readdir(routePath)

for (const filename of filenames) {
  if (filename.endsWith('.js')) {
    const { default: router } = await import(
      pathToFileURL(path.join(routePath, filename))
    )
    const slug = filename.split('.')[0]
    app.use(`${apiPath}/${slug === 'index' ? '' : slug}`, router)
  }
}
// 載入routes中的各路由檔案，並套用api路由 END

// 其他自定義路由
app.use('/reserve', reservationRoutes)
app.use('/auth', memberRoutes)
// 設定支付路由，使用 '/payment' 作為基礎路徑
app.use('/payment', paymentRoutes)
app.use('/history', historyRoutes)

// 捕抓 404 錯誤處理
app.use(function (req, res, next) {
  next(createError(404))
})

// 錯誤處理函式
app.use(function (err, req, res, next) {
  res.locals.message = err.message
  res.locals.error = req.app.get('env') === 'development' ? err : {}
  res.status(err.status || 500).send({ error: err })
})

// 建立 HTTP 伺服器用於聊天
const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', '*'],
    methods: ['GET', 'POST'],
  },
})

const users = {} // 用來儲存每個使用者的socket.id
const adminSockets = new Set() // 用來儲存管理者的socket.id

io.on('connection', (socket) => {
  console.log('使用者連線:', socket.id)

  // 傳送歷史資料給剛登入的用戶
  // sendHistoryMessages(socket);
  socket.on('sendMessage', async (message) => {
    console.log('Message received:', message)

    try {
      const connection = await db.getConnection()

      // 查詢資料庫中最新一條訊息的 isRead 狀態
      const [latestMessage] = await connection.query(
        'SELECT isRead FROM messages ORDER BY timestamp DESC LIMIT 1'
      )
      const latestIsReadStatus = latestMessage[0]
        ? latestMessage[0].isRead
        : false

      // 將訊息傳入資料表messages
      const [results] = await connection.query('INSERT INTO messages SET ?', {
        room: message.room,
        sender: message.sender,
        isMerchant: message.isMerchant,
        message: message.message,
        timestamp: new Date(),
        isRead: message.isRead || false,
      })
      connection.release()
      console.log('訊息儲存的欄位 id:', results.insertId)

      // 新增 timestamp 到 message 物件
      message.timestamp = new Date()

      // 發送新訊息給所有客戶端，並設置 status
      io.emit('newMessage', {
        ...message,
        id: results.insertId,
        status: latestIsReadStatus ? 'read' : 'sent',
      })
    } catch (error) {
      console.error('無法傳入資料表:', error)
    }
  })

  socket.on('roomRestart', async () => {
    // 當收到 roomRestart 事件時，調用 fetchLastMessage
    io.emit('roomRestart')
  })
  socket.on('typing', (data) => {
    console.log('正在輸入中')
    console.log(data)
    // socket.to(data.room).emit('typing', data) // 使用 socket.to 而不是 io.to，這樣事件不會發回發送者，這是錯誤的，前端並沒有收到該訊息
    io.emit('typing', data)
  })
  //監聽前端已讀事件
  //只針對對方目前在此房間內的所有訊息已讀 若沒針對房號的話將會導致她在所有聊天室的訊息都已讀
  socket.on('messageRead', async (data) => {
    const { room, sender } = data
    console.log(data)

    // 根據 sender 的值設置對方的 sender 值
    const otherSender = sender === 1 ? 2 : 1
    console.log(otherSender)

    try {
      const connection = await db.getConnection()
      const [results] = await connection.query(
        'UPDATE messages SET isRead = ? WHERE room = ? AND sender = ? AND isRead = false',
        [true, room, otherSender]
      )
      connection.release()
      console.log('消息已讀狀態已更新')
      console.log(results)

      // 廣播已讀通知給房間內的所有用戶（除了發送者）
      socket.emit('messageRead', {
        id: data.id,
        sender: data.sender,
        status: 'read',
      })
    } catch (error) {
      console.error('無法更新消息已讀狀態:', error)
    }
  })

  socket.on('disconnect', () => {
    console.log('使用者連線:', socket.id)
  })
})

server.listen(3002, () => {
  console.log('聊天用伺服器 http://localhost:3002 已經啟動囉')
})

// 監聽應用程式的port
app.listen(port, () => {
  console.log(`一般伺服器已啟動 http://localhost:${port}`)
})

export default app
