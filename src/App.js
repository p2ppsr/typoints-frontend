import React, { useEffect, useState } from 'react'
import pushdrop from 'pushdrop'
import { createAction, getTransactionOutputs, getPublicKey, submitDirectTransaction } from '@babbage/sdk'
import { Authrite } from 'authrite-js'
import Tokenator from '@babbage/tokenator'

const confederacyHost = 'https://confederacy.babbage.systems'
const peerServHost = 'https://peerserv.babbage.systems'
const messageBox = 'TyPoints-Box'
const protocolID = 'tokens'
const basket = 'TyPoints2'
const topic = 'TyPoints'
const satoshis = 1000

const tokenator = new Tokenator({
  peerServHost
})

const findFromOverlay = async ({ txid, vout }) => {
  const client = new Authrite()
  const result = await client.request(`${confederacyHost}/lookup`, {
    method: 'post',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      provider: topic,
      query: {
        txid,
        vout
      }
    })
  })
  return await result.json()
}

const submitToOverlay = async (tx, topics = [topic]) => {
  const client = new Authrite()
  const result = await client.request(`${confederacyHost}/submit`, {
    method: 'post',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      ...tx,
      topics
    })
  })
  return await result.json()
}

window.submitToOverlay = submitToOverlay
window.getTransactionOutputs = getTransactionOutputs
window.tokenator = tokenator

const App = () => {
  const [tokens, setTokens] = useState(10)
  const [sendAmount, setSendAmount] = useState(10)
  const [recipient, setRecipient] = useState('')
  const [myTokens, setMyTokens] = useState([])
  const [identityKey, setIdentityKey] = useState('---')
  const [myBalance, setMyBalance] = useState(0)

  const handleMint = async () => {
    const tokenScript = await pushdrop.create({
      fields: [
        String(tokens)
      ],
      protocolID,
      keyID: '1'
    })
    const transaction = await createAction({
      outputs: [{
        script: tokenScript,
        satoshis
      }],
      description: `Mint ${tokens} tokens`
    })

    console.log(transaction)

    const tokenForRecipient = {
      txid: transaction.txid,
      vout: 0,
      amount: 1000,
      envelope: {
        ...transaction
      },
      outputScript: tokenScript
    }

    // Send the transaction to the recipient
     await tokenator.sendMessage({
        recipient: await getPublicKey({ identityKey: true }),
        messageBox,
        body: JSON.stringify({
          token: tokenForRecipient
        })
     })
  }

  // To send a token:
  const send = async () => {
    // Make sure the amount is not more than what you have
    if (sendAmount > myBalance) {
      window.alert('Not sufficient tokens.')
      return
    }

    // Create redeem scripts for your tokens
    const inputs = {}
    for (const t of myTokens) {
      console.log(t)
      const unlockingScript = await pushdrop.redeem({
        prevTxId: t.txid,
        outputIndex: t.vout,
        lockingScript: t.outputScript,
        outputAmount: t.amount,
        protocolID,
        keyID: '1',
        counterparty: t.customInstructions ? JSON.parse(t.customInstructions).sender : 'self'
      })
      if (!inputs[t.txid]) {
        inputs[t.txid] = {
          ...t.envelope,
          inputs: typeof t.envelope.inputs === 'string'
            ? JSON.parse(t.envelope.inputs)
            : t.envelope.inputs,
          mapiResponses: typeof t.envelope.mapiResponses === 'string'
            ? JSON.parse(t.envelope.mapiResponses)
            : t.envelope.mapiResponses,
          proof: typeof t.envelope.proof === 'string'
            ? JSON.parse(t.envelope.proof)
            : t.envelope.proof,
          outputsToRedeem: [{
            index: t.vout,
            unlockingScript
          }]
        }
      } else {
        inputs[t.txid].outputsToRedeem.push({
          index: t.vout,
          unlockingScript
        })
      }
    }

    // Create outputs for the recipient and your own change
    const outputs = []
    const recipientScript = await pushdrop.create({
      fields: [
        String(sendAmount)
      ],
      protocolID,
      keyID: '1',
      counterparty: recipient
    })
    outputs.push({
      script: recipientScript,
      satoshis
    })
    let changeScript
    if (myBalance - sendAmount > 0) {
      changeScript = await pushdrop.create({
        fields: [
          String(myBalance - sendAmount)
        ],
        protocolID,
        keyID: '1',
        counterparty: 'self'
      })
      outputs.push({
        script: changeScript,
        basket,
        satoshis,
        customInstructions: JSON.stringify({
          sender: identityKey
        })
      })
    }
    // Create the transaction
    const action = await createAction({
      description: `Send ${sendAmount} tokens to ${recipient}`,
      inputs,
      outputs
    })

    // Send the transaction to the overlay
    await submitToOverlay(action)

    const tokenForRecipient = {
      txid: action.txid,
      vout: 0,
      amount: 1000,
      envelope: {
        ...action
      },
      outputScript: recipientScript
    }

    // Send the transaction to the recipient
     await tokenator.sendMessage({
        recipient,
        messageBox,
        body: JSON.stringify({
          token: tokenForRecipient
        })
    })

    // Update your own tokens to be the new outputs
    let myNewTokens = []
    if (changeScript) {
      action.outputs = [{
        vout: 1,
        basket,
        satoshis,
        customInstructions: JSON.stringify({
          sender: identityKey
        })
      }]
      await submitDirectTransaction({
        senderIdentityKey: identityKey,
        note: 'Reclaim change',
        amount: satoshis,
        transaction: action
      })
      const tokenForChange = {
        txid: action.txid,
        vout: 1,
        amount: 1000,
        envelope: {
          ...action
        },
        outputScript: changeScript
      }
      myNewTokens.push(tokenForChange)
    }
    console.log('myNewTokens', myNewTokens)
    setMyTokens(myNewTokens)
  }

  useEffect(() => {
    (async () => {
      const myIncomingMessages = await tokenator.listMessages({
        messageBox
      })

      const myTokens = await getTransactionOutputs({
        basket,
        includeEnvelope: true,
        spendable: true
      })
      let didTokensChange = false

      // For each incoming message, validate and save the token!
      for (const message of myIncomingMessages) {
        let parsedBody, token
        try {
          parsedBody = JSON.parse(JSON.parse(message.body))
          token = parsedBody.token

          // Verify the token is owned by me
          const decodedToken = pushdrop.decode({
            script: token.outputScript,
            fieldFormat: 'utf8'
          })
          const myKey = await getPublicKey({
            protocolID,
            keyID: '1',
            counterparty: message.sender,
            forSelf: true
          })
          if (myKey !== decodedToken.lockingPublicKey) {
            console.log('Received token not belonging to me!')
            continue
          }
          console.log('This token belongs to me!')

          // Verify the token is on the overlay
          const verified = await findFromOverlay(token)
          if (verified.length < 1) {
            console.log('Token is for me but not on the overlay!')
            continue
          }
          console.log('Token is on the overlay!')

          // Make sure the token is not already in my list of tokens
          if (myTokens.some(t => t.txid === token.txid && t.vout === token.vout)) {
            console.log('Already have this token!')
            continue
          }
          console.log('Do not have this token yet!')

          // Submit transaction
          await submitDirectTransaction({
            senderIdentityKey: message.sender,
            note: 'Receive token',
            amount: satoshis,
            transaction: {
              ...token.envelope,
              outputs: [{
                vout: 0,
                basket,
                satoshis,
                customInstructions: JSON.stringify({
                  sender: message.sender
                })
              }]
            }
          })

          // Save the token in my list of tokens
          myTokens.push(token)
        } catch (e) {
          console.error('got err')
          if (e.message !== `Transaction with txid ${token.txid} has already been inserted`) {
            console.log('throwing err')
            throw e
          }
        }
      }

      // Acknowledge receipt of all messages
      if (myIncomingMessages.length !== 0) {
        await tokenator.acknowledgeMessage({
          messageIds: myIncomingMessages.map(x => x.messageId)
        })
      }

      let balance = 0
      for (const x of myTokens) {
        const t = pushdrop.decode({
          script: x.outputScript,
          fieldFormat: 'utf8'
        })
        balance += Number(t.fields[0])
      }

      setMyBalance(balance)
      setMyTokens(myTokens)
    })()
  }, [])

  useEffect(() => {
    (async () => {
      // Populate our own identity key
      setIdentityKey(await getPublicKey({
        identityKey: true
      }))
    })()
  }, [])

  return (
    <center style={{ margin: '1em' }}>
      <h1>Token Minter</h1>
      <input type='number' value={tokens} onChange={e => setTokens(e.target.value)} />
      <button onClick={handleMint}>Mint</button>
      <h1>Token Sender</h1>
      <input type='number' value={sendAmount} onChange={e => setSendAmount(e.target.value)} />
      <input type='text' value={recipient} onChange={e => setRecipient(e.target.value)} />
      <button onClick={send}>Send</button>
      <p><b>Identity key:</b>{identityKey}</p>
      <p><b>Balance:</b>{myBalance}</p>
      <h2>My Tokens</h2>
      {myTokens.map((x, i) => {
        const tokenPayload = pushdrop.decode({
          script: x.outputScript,
          fieldFormat: 'utf8'
        })
        return (
          <div key={i}>
            <p>amount: {tokenPayload.fields[0]}</p>
          </div>
        )
      })}
    </center>
  )
}

export default App
